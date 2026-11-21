import fsp from "node:fs/promises";
import path from "node:path";
import { getDownloadDir, forgetTasksByDest, migrateLegacyRepoDirs } from "./downloads.js";

const MAX_FILES = 5000;

async function walk(rootAbs, relDir, depth, acc) {
  if (depth > 8 || acc.count >= MAX_FILES) return;
  let entries;
  try {
    entries = await fsp.readdir(relDir ? path.join(rootAbs, relDir) : rootAbs, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (acc.count >= MAX_FILES) return;
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      await walk(rootAbs, rel, depth + 1, acc);
      continue;
    }
    if (!entry.isFile()) continue;

    try {
      const st = await fsp.lstat(path.join(rootAbs, rel));
      acc.files.push({ path: rel, size: st.size, mtime: st.mtime.toISOString() });
      acc.count++;
      acc.size += st.size;
    } catch {
      /* 跳过无法访问的文件 */
    }
  }
}

function decodeRepo(name) {
  return name.includes("__") ? name.replace(/__/g, "/") : null;
}

/** 上一次扫描时做过「org__repo → org/repo」老目录升级的目录 */
let migratedDir = null;

/** 列出下载目录中已有的文件（按仓库目录分组） */
export async function listLocalFiles() {
  const dir = getDownloadDir();
  const groups = [];
  let totalSize = 0;
  let count = 0;

  // 换了下载目录（或首次扫描）时，先把老版本的 org__repo 目录升级成 org/repo
  if (migratedDir !== dir) {
    await migrateLegacyRepoDirs(dir);
    migratedDir = dir;
  }

  const pushGroup = async (relDir, repo, presetAcc, extra) => {
    const acc = presetAcc || { count: 0, size: 0, files: [] };
    if (!presetAcc) await walk(dir, relDir, 0, acc);
    if (!acc.count) return;
    groups.push({
      dir: relDir,
      repo,
      ...extra,
      count: acc.count,
      size: acc.size,
      files: acc.files.sort((a, b) => a.path.localeCompare(b.path, "en", { numeric: true })),
    });
    totalSize += acc.size;
    count += acc.count;
  };

  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { dir, groups: [], totalSize: 0, count: 0 };
  }

  const rootFiles = { count: 0, size: 0, files: [] };

  for (const entry of entries) {
    if (entry.isFile()) {
      try {
        const st = await fsp.lstat(path.join(dir, entry.name));
        rootFiles.files.push({
          path: entry.name,
          size: st.size,
          mtime: st.mtime.toISOString(),
        });
        rootFiles.count++;
        rootFiles.size += st.size;
      } catch {
        /* ignore */
      }
      continue;
    }
    if (!entry.isDirectory()) continue;

    // 隐藏目录（.cache 之类）不当仓库，整块按「散落文件」展示
    if (entry.name.startsWith(".")) {
      await pushGroup(entry.name, null, undefined, { isLoose: true });
      continue;
    }

    // 老布局：klee100__Repo（升级失败或外部拷进来的），仍然按一个仓库目录识别
    const legacyRepo = decodeRepo(entry.name);
    if (legacyRepo) {
      await pushGroup(entry.name, legacyRepo);
      continue;
    }

    // 新布局：一层是 org，二层才是仓库目录，文件在仓库目录下
    const subs = await fsp.readdir(path.join(dir, entry.name), { withFileTypes: true }).catch(() => []);

    // 直接散在 org 目录里的文件单独成组，避免和仓库组混在一起
    const loose = { count: 0, size: 0, files: [] };
    for (const sub of subs) {
      if (!sub.isFile()) continue;
      try {
        const st = await fsp.lstat(path.join(dir, entry.name, sub.name));
        loose.files.push({
          path: `${entry.name}/${sub.name}`,
          size: st.size,
          mtime: st.mtime.toISOString(),
        });
        loose.count++;
        loose.size += st.size;
      } catch {
        /* ignore */
      }
    }

    for (const sub of subs) {
      if (!sub.isDirectory()) continue;
      const rel = `${entry.name}/${sub.name}`;
      // 仓库 id 就是 "org/repo"，界面上的「查看模型」直接用它
      await pushGroup(rel, rel);
    }

    // 标记成「散落文件」组：整组删除会连下面的仓库一起删，界面上不给它「删除整组」按钮
    if (loose.count) await pushGroup(entry.name, null, loose, { isLoose: true });
  }

  if (rootFiles.count) {
    groups.push({
      dir: "",
      repo: null,
      // 根目录散落文件：不给「删除整组」（那等于清空下载目录）
      isLoose: true,
      count: rootFiles.count,
      size: rootFiles.size,
      files: rootFiles.files.sort((a, b) => a.path.localeCompare(b.path)),
    });
    totalSize += rootFiles.size;
    count += rootFiles.count;
  }

  groups.sort((a, b) => b.size - a.size);
  return { dir, groups, totalSize, count };
}

/** 删除下载目录内的文件或文件夹（会做路径越界检查） */
export async function deleteLocal(relPath) {
  const dir = getDownloadDir();
  if (!relPath || typeof relPath !== "string") throw new Error("缺少路径参数");

  const abs = path.resolve(dir, relPath);
  if (abs !== dir && !abs.startsWith(dir + path.sep)) {
    throw new Error("路径超出下载目录范围");
  }
  if (abs === dir) throw new Error("不能删除下载目录本身");

  const st = await fsp.lstat(abs);
  await fsp.rm(abs, { recursive: st.isDirectory(), force: true });
  forgetTasksByDest(abs);

  // 顺手清理空目录
  try {
    let parent = path.dirname(abs);
    while (parent.startsWith(dir + path.sep)) {
      const left = await fsp.readdir(parent);
      if (left.length) break;
      await fsp.rmdir(parent);
      parent = path.dirname(parent);
    }
  } catch {
    /* ignore */
  }

  return { deleted: relPath };
}
