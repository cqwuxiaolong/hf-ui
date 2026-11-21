import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

const FS_TYPES =
  /^(ext[234]|xfs|btrfs|zfs|f2fs|jfs|reiserfs|ntfs3?|exfat|vfat|fat|nfs4?|cifs|smbfs|fuseblk|fuse\..*|fuse|apfs|hfsplus|udf|iso9660)$/i;

const SKIP_MOUNTS = [
  /^\/proc(\/|$)/,
  /^\/sys(\/|$)/,
  /^\/dev(\/|$)/,
  /^\/run(\/|$)(?!media)/,
  /^\/snap(\/|$)/,
  /^\/var\/lib(\/|$)/,
  /^\/var\/snap(\/|$)/,
  /^\/boot\/efi(\/|$)/,
  /^\/boot\/grub(\/|$)/,
  /^\/tmp\/\./,
];

async function isDir(p) {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function diskInfo(p) {
  try {
    const st = await fsp.statfs(p);
    return { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
  } catch {
    return null;
  }
}

function unescapeMount(s) {
  return s.replace(/\\040/g, " ").replace(/\\011/g, "\t").replace(/\\012/g, "\n").replace(/\\134/g, "\\");
}

/** 左侧「我的电脑」：根目录、主目录、常用目录 + 真实挂载点 */
export async function listRoots() {
  const roots = [];
  const seen = new Set();

  const add = async (label, p, kind) => {
    if (!p || seen.has(p)) return;
    if (!(await isDir(p))) return;
    seen.add(p);
    roots.push({ label, path: p, kind, disk: await diskInfo(p) });
  };

  await add("根目录", "/", "root");
  await add("主目录", HOME, "home");
  await add("下载", path.join(HOME, "Downloads"), "folder");
  await add("文档", path.join(HOME, "Documents"), "folder");
  await add("桌面", path.join(HOME, "Desktop"), "folder");

  let mounts = "";
  try {
    mounts = await fsp.readFile("/proc/mounts", "utf8");
  } catch {
    /* 非 Linux 或不可读时仅保留上面的固定目录 */
  }

  for (const line of mounts.split("\n")) {
    const [device, mountPoint, fstype] = line.split(/\s+/);
    if (!mountPoint || !fstype) continue;
    if (!FS_TYPES.test(fstype)) continue;
    if (!device.startsWith("/dev/") && !fstype.match(/^(nfs4?|cifs|smbfs|fuse\..*|fuseblk)$/i)) continue;

    const mp = unescapeMount(mountPoint);
    if (SKIP_MOUNTS.some((re) => re.test(mp))) continue;
    if (mp === "/" || mp === HOME) continue;

    const label = path.basename(mp) || mp;
    await add(label, mp, "disk");
  }

  return roots;
}

/** 列出一个目录下的子目录 */
export async function listDir(input) {
  const abs = path.resolve(input || "/");

  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    throw new Error(`目录不存在：${abs}`);
  }
  if (!st.isDirectory()) throw new Error(`不是目录：${abs}`);

  let entries;
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "EACCES" || err?.code === "EPERM") {
      throw new Error(`没有权限访问：${abs}`);
    }
    throw err;
  }

  const dirs = [];
  for (const entry of entries) {
    let isDirectory = entry.isDirectory();
    if (!isDirectory && entry.isSymbolicLink()) {
      isDirectory = await isDir(path.join(abs, entry.name));
    }
    if (!isDirectory) continue;
    dirs.push({
      name: entry.name,
      path: path.join(abs, entry.name),
      symlink: entry.isSymbolicLink(),
    });
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" }));

  const parsed = path.parse(abs);
  return {
    path: abs,
    parent: abs === parsed.root ? null : path.dirname(abs),
    dirs,
    disk: await diskInfo(abs),
  };
}

/** 在指定目录下新建文件夹 */
export async function createDir(parent, name) {
  const base = path.resolve(parent || "/");
  const folder = String(name || "").trim();

  if (!folder) throw new Error("文件夹名称不能为空");
  if (folder === "." || folder === ".." || /[\\/\0]/.test(folder)) {
    throw new Error("文件夹名称不合法");
  }

  const abs = path.join(base, folder);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error("路径不合法");

  await fsp.mkdir(abs);
  return { path: abs, name: folder };
}
