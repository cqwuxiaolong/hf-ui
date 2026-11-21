import fs from "node:fs";
import path from "node:path";
import { appDir, configHome, isWritable } from "./sea.js";

/**
 * 设置文件位置：默认和程序放一起（开发时就是仓库根，单文件版就是 exe 旁边，便携模式）。
 * 程序放在只读目录（如 Windows 的 Program Files、或 root 拥有的 /opt）时回退到用户配置目录，
 * 否则第一次保存设置就报错。环境变量 SETTINGS_FILE 始终优先。
 */
function defaultSettingsFile() {
  const root = appDir();
  const local = path.join(root, "settings.json");
  // 文件已存在就按文件本身判，否则按所在目录判可写
  if (fs.existsSync(local) ? isWritable(local) : isWritable(root)) return local;
  return path.join(configHome(), "settings.json");
}

const FILE = process.env.SETTINGS_FILE || defaultSettingsFile();

export function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
  } catch {
    /* 目录已存在或没有权限：让下面的写入报出真实错误 */
  }
  fs.writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`);
  // 一旦存过访问令牌，这个文件就是敏感文件：收紧到仅当前用户可读写
  if (typeof next.hfToken === "string" && next.hfToken.trim()) {
    try {
      fs.chmodSync(FILE, 0o600);
    } catch {
      /* 某些文件系统不支持 chmod，忽略 */
    }
  }
  return next;
}

export { FILE as SETTINGS_FILE };
