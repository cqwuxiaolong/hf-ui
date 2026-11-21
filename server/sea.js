// 单文件（Node SEA）运行时支持。
//
// 发布产物是一个「Node 运行时 + 服务端代码 + 前端 dist + xet-dl 下载器」拼在一起的裸可执行文件
// （scripts/build-sea.mjs 用 node --build-sea 生成）。普通部署（pnpm build && pnpm start）里
// IS_SEA 恒为 false，这里的所有函数自动退回磁盘路径，服务端行为与单文件版之前完全一致。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as sea from "node:sea";

export const IS_SEA = typeof sea.isSea === "function" && sea.isSea();

/** 打包成 CJS 后 import.meta.url 会被丢掉（值为 undefined），所以取不到就返回 null */
export function sourceDir() {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

/** 应用目录：普通部署 = 仓库根；单文件 = 可执行文件所在目录（跟随 exe，不跟随 cwd） */
export function appDir() {
  if (IS_SEA) {
    try {
      return path.dirname(fs.realpathSync(process.execPath));
    } catch {
      return path.dirname(process.execPath);
    }
  }
  const dir = sourceDir();
  return dir ? path.resolve(dir, "..") : process.cwd();
}

export function isWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function firstWritable(candidates) {
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (isWritable(dir)) return dir;
    } catch {
      /* 换下一个候选 */
    }
  }
  return candidates[candidates.length - 1];
}

const APP_NAME = "hf-web-manager";

function home() {
  return process.env.HOME || os.homedir() || process.cwd();
}

/** 配置文件目录（XDG 口径） */
export function configHome() {
  if (process.platform === "win32") return firstWritable([process.env.APPDATA && path.join(process.env.APPDATA, APP_NAME)]);
  if (process.platform === "darwin") return firstWritable([path.join(home(), "Library", "Application Support", APP_NAME)]);
  return firstWritable([process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, APP_NAME), path.join(home(), ".config", APP_NAME)]);
}

/** 数据目录（下载目录的兜底位置） */
export function dataHome() {
  if (process.platform === "win32") return firstWritable([process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, APP_NAME)]);
  if (process.platform === "darwin") return firstWritable([path.join(home(), "Library", "Application Support", APP_NAME)]);
  return firstWritable([process.env.XDG_DATA_HOME && path.join(process.env.XDG_DATA_HOME, APP_NAME), path.join(home(), ".local", "share", APP_NAME)]);
}

/** 缓存目录（内嵌 xet-dl 释放到这里） */
export function cacheHome() {
  if (process.platform === "win32") return firstWritable([process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, APP_NAME, "cache")]);
  if (process.platform === "darwin") return firstWritable([path.join(home(), "Library", "Caches", APP_NAME)]);
  return firstWritable([process.env.XDG_CACHE_HOME && path.join(process.env.XDG_CACHE_HOME, APP_NAME), path.join(home(), ".cache", APP_NAME)]);
}

// ---- 内嵌资源 ---------------------------------------------------------------

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  return Buffer.from(value);
}

export function assetKeys() {
  if (!IS_SEA) return [];
  try {
    return sea.getAssetKeys();
  } catch {
    return [];
  }
}

/** 读内嵌资源；普通部署或非-existent key 返回 null */
export function asset(key) {
  if (!IS_SEA) return null;
  try {
    return toBuffer(sea.getRawAsset(key));
  } catch {
    try {
      return toBuffer(sea.getAsset(key));
    } catch {
      return null;
    }
  }
}

let meta;

/** 版本与构建信息：单文件读内嵌 meta.json，普通部署读仓库根的 package.json */
export function appMeta() {
  if (meta) return meta;
  let info = {};
  const raw = IS_SEA ? asset("meta.json") : null;
  if (raw) {
    try {
      info = JSON.parse(raw.toString("utf8"));
    } catch {
      /* 内嵌信息坏了也不要紧，只影响 --version 显示 */
    }
  } else {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(appDir(), "package.json"), "utf8"));
      info = { name: pkg.name, version: pkg.version };
    } catch {
      /* 同上 */
    }
  }
  meta = { name: APP_NAME, version: "0.0.0", target: "source", ...info };
  return meta;
}

let extractedXet;

/**
 * 单文件模式下把内嵌的 xet-dl 释放到缓存目录并返回可执行路径（普通部署返回 null，
 * 由 downloads.js 去磁盘上找）。释放文件名带版本号，升级时不会撞上旧文件。
 */
export function extractXetBinary() {
  if (!IS_SEA) return null;
  if (extractedXet) return extractedXet;
  const buf = asset("bin/xet-dl");
  if (!buf) return null;
  const exe = process.platform === "win32" ? "xet-dl.exe" : "xet-dl";
  const dir = path.join(cacheHome(), "bin", appMeta().version);
  const target = path.join(dir, exe);
  try {
    if (fs.existsSync(target) && fs.statSync(target).size === buf.length) {
      extractedXet = target;
      return target;
    }
  } catch {
    /* 当作不存在，重写一遍 */
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `${exe}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, buf);
    try {
      fs.chmodSync(tmp, 0o755);
    } catch {
      /* Windows 没有 chmod，忽略 */
    }
    try {
      fs.rmSync(target, { force: true });
    } catch {
      /* Windows 上旧文件可能正被占用，忽略后走 pid 文件名 */
    }
    try {
      fs.renameSync(tmp, target);
      extractedXet = target;
    } catch {
      const alt = path.join(dir, `${process.pid}-${exe}`);
      fs.renameSync(tmp, alt);
      extractedXet = alt;
    }
  } catch (err) {
    console.warn(`[xet] 释放内嵌下载器失败，退回磁盘查找：${err.message}`);
    return null;
  }
  return extractedXet;
}
