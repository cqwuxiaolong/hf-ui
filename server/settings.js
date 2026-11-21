import fs from "node:fs";
import path from "node:path";

const FILE = process.env.SETTINGS_FILE || path.resolve(process.cwd(), "settings.json");

export function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
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
