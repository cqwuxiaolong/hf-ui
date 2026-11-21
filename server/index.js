import express from "express";
import fs from "node:fs";
import path from "node:path";
import {
  ENDPOINT,
  clearHfCaches,
  getModel,
  getReadme,
  getToken,
  listRepoFiles,
  resolveUrl,
  searchModels,
  setToken,
  tokenStatus,
  verifyToken,
} from "./hf.js";
import {
  cancelDownload,
  clearXetMetaCache,
  diskFree,
  getDownloadDir,
  getXetHighPerformance,
  getXetMemoryBudgetMb,
  getTasks,
  localFileInfo,
  migrateLegacyRepoDirs,
  pauseAllDownloads,
  pauseDownload,
  removeDownload,
  resumeAllDownloads,
  resumeDownload,
  setDownloadDir,
  setXetHighPerformance,
  setXetMemoryBudgetMb,
  startDownload,
  subscribe,
} from "./downloads.js";
import { deleteLocal, listLocalFiles } from "./local.js";
import { createDir, listDir, listRoots } from "./fsbrowse.js";
import { IS_SEA, appDir, appMeta, sourceDir } from "./sea.js";
import { embeddedWebMiddleware } from "./webroot.js";

// 打包进单文件后 import.meta.url 会被丢掉（CJS 里没有），取不到就说明没有磁盘上的 dist
const SRC_DIR = sourceDir();
const STATIC_DIST = SRC_DIR ? path.join(SRC_DIR, "..", "dist") : null;
const PORT = Number(process.env.PORT || 2270);
const HOST = process.env.HOST || "0.0.0.0";

const ARGS = process.argv.slice(2);
const META = appMeta();

if (ARGS.includes("--version") || ARGS.includes("-V")) {
  console.log(`${META.name} ${META.version} · 目标平台 ${META.target} · Node ${process.versions.node}${IS_SEA ? " · 单文件（前端与下载器已内嵌）" : " · 源码运行"}`);
  process.exit(0);
}

if (ARGS.includes("--help") || ARGS.includes("-h")) {
  console.log(`
HF 模型管理器（浏览器界面 + 本地服务）

  用法：${IS_SEA ? process.argv[1] : "node server/index.js"} [选项]

  选项
    -h, --help      显示本帮助
    -V, --version   显示版本

  环境变量
    PORT=2270            监听端口
    HOST=0.0.0.0         监听地址（只想本机访问就设 127.0.0.1）
    DOWNLOAD_DIR=...     模型下载目录（单文件版默认可执行文件旁边的 downloads/）
    SETTINGS_FILE=...    设置文件位置（默认程序旁 settings.json，只读时退到用户配置目录）
    HF_TOKEN=...         Hugging Face 访问令牌（也可在界面上配置）
    HF_ENDPOINT=...      镜像站地址，默认 https://hf-mirror.com
    DOWNLOAD_ENGINE=...  auto | xet | fetch，默认 auto（有 xet-dl 就用 Xet 多连接）
    XET_DL_BIN=...       指定外部 xet-dl 可执行文件

  启动后浏览器打开 http://localhost:${PORT}
`);
  process.exit(0);
}

const app = express();
app.use(express.json({ limit: "256kb" }));

const REPO_RE = /^[\w.\-]+\/[\w.\-]+$/;

function bad(res, status, message) {
  res.status(status).json({ error: message });
}

function wrap(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error("[api]", err);
      if (!res.headersSent) bad(res, 500, err?.message || "服务器错误");
    });
  };
}

async function configPayload() {
  const disk = await diskFree();
  const token = tokenStatus();
  return {
    endpoint: ENDPOINT,
    downloadDir: getDownloadDir(),
    hasToken: token.hasToken,
    token,
    maxConcurrent: Number(process.env.MAX_CONCURRENT_DOWNLOADS || 2),
    xetHighPerformance: getXetHighPerformance(),
    xetMemoryBudgetMb: getXetMemoryBudgetMb(),
    disk,
  };
}

app.get("/api/config", wrap(async (_req, res) => {
  res.json(await configPayload());
}));

app.post("/api/config", wrap(async (req, res) => {
  const body = req.body || {};
  const patch = {};

  if (body.downloadDir !== undefined) {
    if (typeof body.downloadDir !== "string" || !body.downloadDir.trim()) {
      return bad(res, 400, "downloadDir 必须是非空字符串");
    }
    try {
      await setDownloadDir(body.downloadDir);
    } catch (err) {
      return bad(res, 400, `无法使用该目录：${err.message}`);
    }
  }

  if (body.xetHighPerformance !== undefined) {
    if (typeof body.xetHighPerformance !== "boolean") {
      return bad(res, 400, "xetHighPerformance 需要是布尔值");
    }
    try {
      patch.xetHighPerformance = setXetHighPerformance(body.xetHighPerformance);
    } catch (err) {
      return bad(res, 400, err.message);
    }
  }

  if (body.hfToken !== undefined) {
    if (typeof body.hfToken !== "string") return bad(res, 400, "hfToken 需要是字符串");
    const next = body.hfToken.trim();
    if (next) {
      // 先校验再保存，免得存了个错令牌后一路 401 才发现；镜像站不可达时放行（只提示）
      const check = await verifyToken(next);
      if (check.ok === false) {
        return bad(res, 400, `令牌校验失败（HTTP ${check.status}）：请到镜像站的 settings/tokens 确认令牌有效且未过期`);
      }
      if (check.ok === null) {
        patch.tokenWarning = `暂时无法连镜像站校验令牌（${check.error || `HTTP ${check.status}`}），已按原样保存`;
      }
      patch.tokenUser = check.user || null;
    }
    patch.token = setToken(next);
    whoamiCache = { at: 0, token: "", detail: {} };
    clearHfCaches();
    clearXetMetaCache();
  }

  if (body.xetMemoryBudgetMb !== undefined) {
    try {
      patch.xetMemoryBudgetMb = setXetMemoryBudgetMb(body.xetMemoryBudgetMb);
    } catch (err) {
      return bad(res, 400, err.message);
    }
  }

  res.json({ ...(await configPayload()), ...patch });
}));

/* 令牌详情：掩码 + 归属账号（whoami 结果缓存 5 分钟，避免每次开弹窗都打镜像站） */
let whoamiCache = { at: 0, token: "", detail: {} };

async function tokenDetail() {
  const status = tokenStatus();
  if (!status.hasToken) return { ...status, verified: null, user: null };
  const live = getToken();
  if (whoamiCache.token === live && Date.now() - whoamiCache.at < 5 * 60 * 1000) {
    return { ...status, ...whoamiCache.detail };
  }
  const v = await verifyToken(live);
  const detail =
    v.ok === true
      ? { verified: true, user: v.user }
      : v.ok === false
        ? { verified: false, status: v.status }
        : { verified: null, error: v.error || `镜像站返回 HTTP ${v.status}` };
  whoamiCache = { at: Date.now(), token: live, detail };
  return { ...status, ...detail };
}

app.get("/api/token", wrap(async (_req, res) => {
  res.json(await tokenDetail());
}));

app.get("/api/local", wrap(async (_req, res) => {
  const data = await listLocalFiles();
  res.json({ ...data, disk: await diskFree() });
}));

app.delete("/api/local", wrap(async (req, res) => {
  const rel = req.query.path;
  try {
    res.json(await deleteLocal(String(rel || "")));
  } catch (err) {
    if (err?.code === "ENOENT") return bad(res, 404, "文件不存在");
    return bad(res, 400, err.message);
  }
}));

app.get("/api/fs/roots", wrap(async (_req, res) => {
  res.json({ roots: await listRoots(), home: process.env.HOME || "" });
}));

app.get("/api/fs/list", wrap(async (req, res) => {
  try {
    res.json(await listDir(String(req.query.path || "/")));
  } catch (err) {
    return bad(res, 400, err.message);
  }
}));

app.post("/api/fs/mkdir", wrap(async (req, res) => {
  const { path: parent, name } = req.body || {};
  try {
    res.json(await createDir(String(parent || "/"), name));
  } catch (err) {
    const message =
      err?.code === "EEXIST"
        ? "同名文件夹已存在"
        : err?.code === "EACCES"
          ? "没有权限在此处创建文件夹"
          : err.message;
    return bad(res, 400, message);
  }
}));

app.get("/api/search", wrap(async (req, res) => {
  const q = String(req.query.q || "").trim();
  const sort = String(req.query.sort || "downloads");
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));

  if (!q) return res.json({ models: [] });

  const models = await searchModels({ query: q, sort, limit });

  // 直接粘贴 owner/name 时，确保精确命中排在最前
  if (REPO_RE.test(q)) {
    const exact = await getModel(q);
    if (exact) {
      const idx = models.findIndex((m) => m.id === q);
      if (idx >= 0) models.splice(idx, 1);
      models.unshift(exact);
    }
  }

  res.json({ models });
}));

app.get("/api/model", wrap(async (req, res) => {
  const repo = String(req.query.repo || "").trim();
  if (!REPO_RE.test(repo)) return bad(res, 400, "非法模型名，应为 owner/name");
  const info = await getModel(repo);
  if (!info) return bad(res, 404, "模型不存在或无法访问");
  res.json({ model: info });
}));

app.get("/api/files", wrap(async (req, res) => {
  const repo = String(req.query.repo || "").trim();
  const revision = String(req.query.revision || "main").trim() || "main";
  if (!REPO_RE.test(repo)) return bad(res, 400, "非法模型名，应为 owner/name");

  const data = await listRepoFiles(repo, revision);

  const files = await Promise.all(
    data.files.map(async (f) => {
      const local = await localFileInfo(repo, f.path);
      return {
        ...f,
        downloadUrl: resolveUrl(repo, f.path, revision),
        local: local.exists
          ? {
              size: local.size,
              complete: local.size >= f.size,
              // 相对下载目录的路径，前端用它调 DELETE /api/local 清理半成品
              rel: path.relative(getDownloadDir(), local.dest),
            }
          : null,
      };
    }),
  );

  res.json({ ...data, files });
}));

app.get("/api/readme", wrap(async (req, res) => {
  const repo = String(req.query.repo || "").trim();
  const force = req.query.force === "1";
  if (!REPO_RE.test(repo)) return bad(res, 400, "非法模型名，应为 owner/name");
  try {
    res.json({ readme: await getReadme(repo, { force }) });
  } catch (err) {
    return bad(res, 502, `读取 README 失败：${err.message}`);
  }
}));

app.get("/api/tasks", wrap(async (_req, res) => {
  res.json({ tasks: getTasks() });
}));

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  subscribe(req, res);
});

app.post("/api/tasks", wrap(async (req, res) => {
  const { repo, file, size } = req.body || {};
  if (!REPO_RE.test(String(repo || ""))) return bad(res, 400, "非法模型名");
  if (!file) return bad(res, 400, "缺少 file 参数");
  const task = startDownload({ repo, file, size });
  res.json({ task });
}));

app.post("/api/tasks/:id/cancel", wrap(async (req, res) => {
  try {
    res.json({ task: cancelDownload(req.params.id) });
  } catch (err) {
    return bad(res, 404, err.message);
  }
}));

app.post("/api/tasks/:id/pause", wrap(async (req, res) => {
  try {
    res.json({ task: pauseDownload(req.params.id) });
  } catch (err) {
    return bad(res, 400, err.message);
  }
}));

app.post("/api/tasks/:id/resume", wrap(async (req, res) => {
  try {
    res.json({ task: resumeDownload(req.params.id) });
  } catch (err) {
    return bad(res, 400, err.message);
  }
}));

app.delete("/api/tasks/:id", wrap(async (req, res) => {
  const deleteFile = req.query.deleteFile === "1";
  const ok = removeDownload(req.params.id, { deleteFile });
  if (!ok) return bad(res, 404, "任务不存在");
  res.json({ ok });
}));

app.post("/api/tasks/cancel-all", wrap(async (_req, res) => {
  for (const task of getTasks()) {
    if (["running", "queued", "retrying"].includes(task.status)) {
      cancelDownload(task.id);
    }
  }
  res.json({ ok: true, tasks: getTasks() });
}));

app.post("/api/tasks/pause-all", wrap(async (_req, res) => {
  pauseAllDownloads();
  res.json({ ok: true, tasks: getTasks() });
}));

app.post("/api/tasks/resume-all", wrap(async (_req, res) => {
  resumeAllDownloads();
  res.json({ ok: true, tasks: getTasks() });
}));

app.use("/api", (_req, res) => bad(res, 404, "接口不存在"));

// 生产模式：托管 vite 构建产物。单文件版从内存里发（前端已内嵌），普通部署读磁盘上的 dist。
const embedded = embeddedWebMiddleware();
const dist = STATIC_DIST;
if (embedded) {
  app.use(embedded);
} else if (dist && fs.existsSync(path.join(dist, "index.html"))) {
  app.use(express.static(dist, { index: "index.html" }));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    res.sendFile(path.join(dist, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res.type("html").send(
      `<pre style="font-family:ui-monospace;padding:24px;line-height:1.6">
HF 模型管理器 API 已启动（端口 ${PORT}），但还没有前端构建产物。

开发：pnpm dev      （前端 http://localhost:${PORT}）
生产：pnpm build && pnpm start
</pre>`,
    );
  });
}

// 打包成单文件时入口是 CommonJS，不支持顶层 await，所以启动流程包在一个 async 函数里。
async function start() {
  // 老版本的 org__repo 目录 → org/repo 两层结构（同一文件系统 rename，瞬时，不动文件内容）
  const moved = await migrateLegacyRepoDirs();
  for (const m of moved) console.log(`  目录升级       →  ${m.from}  →  ${m.to}`);
  if (moved.length) console.log("");

  app.listen(PORT, HOST, () => {
    console.log(`\n  HF 模型管理器 ${META.version}  →  http://localhost:${PORT}`);
    console.log(`  镜像站         →  ${ENDPOINT}`);
    console.log(`  下载目录       →  ${getDownloadDir()}`);
    console.log(
      `  运行形态       →  ${IS_SEA ? `单文件（目标 ${META.target}，前端与 xet-dl 已内嵌）· 程序目录 ${appDir()}` : "源码运行（pnpm start）"}`,
    );
    console.log(
      `  Xet 调优       →  高性能${getXetHighPerformance() ? "开（并发 124）" : "关（并发 64）"} / 缓冲预算 ${getXetMemoryBudgetMb()} MB`,
    );
    const tk = tokenStatus();
    console.log(
      `  访问令牌       →  ${
        tk.hasToken
          ? `已配置 ${tk.hint}（来源：${tk.source === "env" ? "环境变量" : "界面设置"}）`
          : tk.source === "cleared"
            ? "已在界面上清除（忽略 HF_TOKEN 环境变量）"
            : "未配置（仅公开仓库；点界面顶部「未配置令牌」配置）"
      }\n`);
  });
}

start().catch((err) => {
  console.error("[启动失败]", err);
  process.exit(1);
});
