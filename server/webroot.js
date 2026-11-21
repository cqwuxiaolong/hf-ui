// 单文件版的前端托管：vite 的 dist 产物在打包时以 web/<相对路径> 内嵌进可执行文件
// （见 scripts/build-sea.mjs），这里把它们枚举到内存里，用中间件替代 express.static。
// 普通部署返回 null，index.js 继续用磁盘上的 dist。
import crypto from "node:crypto";
import path from "node:path";
import { IS_SEA, asset, assetKeys } from "./sea.js";

const WEB_PREFIX = "web/";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

let table;

/** 内存里的前端文件表：URL 路径 → { body, type, immutable, etag }；非单文件版返回 null */
export function embeddedWebFiles() {
  if (!IS_SEA) return null;
  if (table) return table;
  const map = new Map();
  for (const key of assetKeys()) {
    if (!key.startsWith(WEB_PREFIX)) continue;
    const rel = key.slice(WEB_PREFIX.length);
    if (!rel || rel.endsWith("/")) continue;
    const body = asset(key);
    if (!body) continue;
    map.set(`/${rel.split(path.posix.sep).join("/")}`, {
      body,
      type: MIME[path.posix.extname(rel).toLowerCase()] || "application/octet-stream",
      // vite 产物里 assets/ 下的文件名带内容哈希，可以永久缓存；index.html 必须每次校验
      immutable: rel.startsWith("assets/"),
      etag: `"${crypto.createHash("sha1").update(body).digest("base64url").slice(0, 20)}"`,
    });
  }
  table = map.size ? map : null;
  return table;
}

/** 返回 express 中间件；非单文件版返回 null */
export function embeddedWebMiddleware() {
  const files = embeddedWebFiles();
  if (!files) return null;
  const index = files.get("/index.html");
  return function serveEmbedded(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let urlPath;
    try {
      urlPath = decodeURIComponent(req.path);
    } catch {
      return next();
    }
    if (!urlPath.startsWith("/") || urlPath.includes("..")) return next();
    if (urlPath.endsWith("/")) urlPath += "index.html";
    let item = files.get(urlPath);
    if (!item) {
      // 单页应用回退：没有扩展名的路径交给前端路由；带扩展名的（漏掉的图片等）直接 404
      if (index && !path.posix.extname(urlPath)) item = index;
      else return next();
    }
    if (req.headers["if-none-match"] === item.etag) {
      res.status(304).end();
      return;
    }
    res.setHeader("ETag", item.etag);
    res.setHeader("Content-Type", item.type);
    res.setHeader("Cache-Control", item.immutable ? "public, max-age=31536000, immutable" : "no-cache");
    res.send(item.body);
  };
}
