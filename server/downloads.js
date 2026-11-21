import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { ENDPOINT, authHeaders, getToken, resolveUrl } from "./hf.js";
import { loadSettings, saveSettings } from "./settings.js";
import { IS_SEA, appDir, dataHome, extractXetBinary, isWritable } from "./sea.js";

/**
 * 默认下载目录。普通部署沿用 cwd/downloads（历史行为）；单文件版不能指望 cwd
 * （双击启动时 cwd 就是 exe 所在目录，但用 systemd / 服务包装时未必），所以
 * 优先 exe 旁边的 downloads/，那里不可写就退到用户数据目录。
 */
function defaultDownloadDir() {
  if (!IS_SEA) return path.join(process.cwd(), "downloads");
  const nextToExe = path.join(appDir(), "downloads");
  return isWritable(appDir()) ? nextToExe : path.join(dataHome(), "downloads");
}

function initialDownloadDir() {
  const fromEnv = process.env.DOWNLOAD_DIR;
  const fromSettings = loadSettings().downloadDir;
  return path.resolve(fromEnv || fromSettings || defaultDownloadDir());
}

let downloadDir = initialDownloadDir();

export function getDownloadDir() {
  return downloadDir;
}

/** 修改下载目录（会立即创建目录、检查可写权限并持久化） */
export async function setDownloadDir(input) {
  if (!input || typeof input !== "string") throw new Error("下载目录不能为空");
  const expanded = input.trim().replace(/^~(?=$|\/)/, process.env.HOME || "~");
  const abs = path.resolve(expanded);

  await fsp.mkdir(abs, { recursive: true });
  await fsp.access(abs, fs.constants.W_OK);

  if (abs === downloadDir) return abs;

  downloadDir = abs;
  saveSettings({ downloadDir: abs });
  emit("update");
  return abs;
}

/* ---------------- Xet 调优：前端可设置 ----------------
 * 两项都存在 settings.json 里；没设置过时回退到环境变量，方便老部署无感升级。
 * 只对「新创建 / 新启动」的下载任务生效，跑着的老任务要重启任务才会换参数。
 */
const XET_BUDGET_MIN_MB = 128;
const XET_BUDGET_MAX_MB = 32_768;

function truthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

/** 高性能模式是否开启（并发 64 → 124，缓冲仍受内存预算约束） */
export function getXetHighPerformance() {
  const stored = loadSettings().xetHighPerformance;
  if (typeof stored === "boolean") return stored;
  return truthyEnv(process.env.HF_XET_HIGH_PERFORMANCE ?? process.env.HF_XET_HP);
}

export function setXetHighPerformance(on) {
  const next = Boolean(on);
  if (getXetHighPerformance() === next) return next;
  saveSettings({ xetHighPerformance: next });
  emit("update");
  return next;
}

/** xet 子进程的下载缓冲内存预算（MB） */
export function getXetMemoryBudgetMb() {
  const stored = Number(loadSettings().xetMemoryBudgetMb);
  if (Number.isFinite(stored) && stored >= XET_BUDGET_MIN_MB && stored <= XET_BUDGET_MAX_MB) {
    return Math.round(stored);
  }
  const fromEnv = Number(process.env.XET_MEMORY_BUDGET_MB);
  if (Number.isFinite(fromEnv) && fromEnv >= XET_BUDGET_MIN_MB && fromEnv <= XET_BUDGET_MAX_MB) {
    return Math.round(fromEnv);
  }
  return 1024;
}

export function setXetMemoryBudgetMb(mb) {
  const next = Math.round(Number(mb));
  if (!Number.isFinite(next) || next < XET_BUDGET_MIN_MB || next > XET_BUDGET_MAX_MB) {
    throw new Error(`内存预算需在 ${XET_BUDGET_MIN_MB} ~ ${XET_BUDGET_MAX_MB} MB 之间`);
  }
  if (getXetMemoryBudgetMb() === next) return next;
  saveSettings({ xetMemoryBudgetMb: next });
  emit("update");
  return next;
}

const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT_DOWNLOADS || 2));
const TICK_MS = 500;

// 网络失败自动重试：指数退避（2s → 4s → 8s…），连续失败超过次数后转为 error 状态
const MAX_AUTO_RETRIES = Math.max(0, Number(process.env.MAX_AUTO_RETRIES ?? 3));
const RETRY_BASE_DELAY = Math.max(200, Number(process.env.RETRY_BASE_DELAY_MS ?? 2000));
// 下载中超过这么久没收到任何字节视为连接卡死，主动中断并触发自动重试
const STALL_TIMEOUT = Math.max(1000, Number(process.env.STALL_TIMEOUT_MS ?? 30000));
// 请求发出后等待响应头的超时（覆盖重定向链），超时按网络错误处理
const HEADERS_TIMEOUT = Math.max(5000, Number(process.env.HEADERS_TIMEOUT_MS ?? 90000));

// ---- 下载引擎：Xet（Rust hf-xet 子进程）vs fetch（Node 单连接）---------------
// 实测（同一文件 / 同一时段 / 同一镜像站）：fetch 单连接 4.4 MB/s，Xet 多连接 10.1 MB/s。
// 两个引擎都能续传：fetch 走 HTTP Range；Xet 走流式 range 下载（download_stream_blocking），
// 它的落盘是严格顺序的，文件长度始终等于有效前缀，所以中断后能接着下（见 native/xet-dl）。
const DOWNLOAD_ENGINE = (process.env.DOWNLOAD_ENGINE || "auto").toLowerCase(); // auto | xet | fetch
// 下载器位置的优先级：环境变量 → 单文件版内嵌（释放到缓存目录）→ 程序目录旁的构建产物 → cwd。
// 单文件版没有磁盘上的 native/，靠 extractXetBinary() 把内嵌的 xet-dl 落盘后调用。
const XET_EXE = process.platform === "win32" ? ".exe" : "";
const XET_APP_DIR = appDir();
// 内嵌下载器的释放有 IO，放进候选列表的 getter 里，等第一次真的要用 Xet 时才执行。
function xetBinCandidates() {
  return [
    process.env.XET_DL_BIN,
    extractXetBinary(),
    path.join(XET_APP_DIR, "native", "bin", `xet-dl${XET_EXE}`),
    path.join(XET_APP_DIR, "native", "xet-dl", "target", "release", `xet-dl${XET_EXE}`),
    path.join(process.cwd(), "native", "bin", `xet-dl${XET_EXE}`),
    path.join(process.cwd(), "native", "xet-dl", "target", "release", `xet-dl${XET_EXE}`),
  ].filter(Boolean);
}
const XET_TMP_SUFFIX = ".xet-partial";
// Xet 续传状态文件目录。刻意不放在下载目录里：那里是给用户看的模型仓，
// 多出一堆 .json 会被本地文件列表当成散落文件，也会污染 basalt 的扫描。
const XET_STATE_DIR = process.env.XET_STATE_DIR
  ? path.resolve(process.env.XET_STATE_DIR)
  : path.join(os.homedir() || process.cwd(), ".cache", "hf-web-manager", "xet-state");

/** 每个半成品一个状态文件（记「已确认写入的字节数」），按目标路径哈希命名 */
function xetStatePath(partialPath) {
  const key = createHash("sha1").update(partialPath).digest("hex").slice(0, 20);
  return path.join(XET_STATE_DIR, `${key}.json`);
}
const XET_META_TTL_HIT = 6 * 60 * 60 * 1000;
const XET_META_TTL_MISS = 5 * 60 * 1000;
// Xet 是按数据块批量落盘的，进度会跳一大段再停顿，卡死判定窗口要比 fetch 宽松
// Xet 每完成一个「数据项」才落盘一次（实测单项 50～260 MB），开头几十秒 0 字节是正常的；
// 窗口放宽到 10 分钟，避免把慢启动误判成卡死而反复重试。
const XET_STALL_TIMEOUT = Math.max(5000, Number(process.env.STALL_TIMEOUT_XET_MS ?? 600000));
// Xet 落盘是跳变的，瞬时速率没意义；速度取最近这段时间窗口的平均值
const XET_SPEED_WINDOW = Math.max(2000, Number(process.env.XET_SPEED_WINDOW_MS ?? 60000));
/** @type {Map<string, {at: number, hash: string, sha256: string, size: number}>} */
const xetMetaCache = new Map();
let xetBinPath = null; // null=未探测，""=探测过且不可用

function abortError(message) {
  const err = new Error(message || "已中断");
  err.name = "AbortError";
  return err;
}

/** 找到可用的 Rust 下载器（只探测一次） */
function xetBin() {
  if (xetBinPath !== null) return xetBinPath;
  const found = xetBinCandidates().find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  xetBinPath = found || "";
  return xetBinPath;
}

function xetReadTokenUrl(repo, revision = "main") {
  const encodedRepo = repo.split("/").map(encodeURIComponent).join("/");
  return `${ENDPOINT}/api/models/${encodedRepo}/xet-read-token/${encodeURIComponent(revision)}`;
}

/** 令牌变了就丢掉 Xet 文件指纹缓存（之前按「无令牌」探测到的结果可能没权限或大小不同） */
export function clearXetMetaCache() {
  xetMetaCache.clear();
}

/** HEAD 探测 /resolve 拿到 Xet 指纹（x-xet-hash）；非 Xet 存储的文件拿不到该头 */
async function xetFileMeta(repo, file) {
  const key = `${repo}::${file}`;
  const hit = xetMetaCache.get(key);
  const ttl = hit && hit.hash ? XET_META_TTL_HIT : XET_META_TTL_MISS;
  if (hit && Date.now() - hit.at < ttl) return hit;

  const meta = { at: Date.now(), hash: "", sha256: "", size: 0 };
  try {
    const res = await fetch(`${resolveUrl(repo, file)}?xet-probe=${Date.now()}`, {
      method: "HEAD",
      headers: { ...authHeaders(), "user-agent": "hf-web-manager/1.0 (xet-probe)" },
      redirect: "manual",
    });
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    meta.hash = res.headers.get("x-xet-hash") || "";
    meta.size = Number(res.headers.get("x-linked-size") || 0) || 0;
    meta.sha256 = (res.headers.get("x-linked-etag") || "").replace(/"/g, "");
  } catch {
    /* 探测失败就按「不支持 Xet」处理，自动回退 fetch */
  }
  xetMetaCache.set(key, meta);
  return meta;
}

/** @type {Map<string, any>} */
const tasks = new Map();
/** @type {Set<import('express').Response>} */
const clients = new Set();

let running = 0;
const queue = [];

function safeRelativePath(file) {
  const parts = String(file).split("/").filter(Boolean);
  if (!parts.length) throw new Error("非法文件路径");
  for (const part of parts) {
    if (part === "." || part === ".." || part.includes("\\") || part.includes("\0")) {
      throw new Error("非法文件路径");
    }
  }
  return path.join(...parts);
}

/**
 * 仓库在下载目录下的相对路径：<org>/<repo>
 * 保持和 Hugging Face 一致的两层结构（org 是目录，仓库名也是目录，文件在仓库目录下），
 * 不再把 "org/repo" 里的斜杠塞成 "org__repo"。每一段单独清洗非法字符。
 */
export function repoSubdir(repo) {
  const parts = String(repo)
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p && p !== "." && p !== "..");
  if (!parts.length) throw new Error("非法仓库名");
  return parts.map((p) => p.replace(/[^\w.\-@]/g, "_")).join("/");
}

export function destinationFor(repo, file) {
  return path.join(downloadDir, repoSubdir(repo), safeRelativePath(file));
}

/**
 * 老版本把仓库名里的 "/" 写成 "__"（如 klee100__Some-Model）。启动时把这类目录改成
 * klee100/Some-Model 两层结构：同一文件系统内 rename 是瞬时的，不动文件内容。
 * 失败（权限 / 目标已存在 / 跨盘）就保持原样，本地列表仍然认老的 "__" 目录。
 */
export async function migrateLegacyRepoDirs(dir = downloadDir) {
  const moved = [];
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return moved;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.includes("__")) continue;
    const parts = entry.name.split("__").filter(Boolean);
    if (parts.length < 2) continue;
    const toRel = parts.join("/");
    const from = path.join(dir, entry.name);
    const to = path.join(dir, toRel);
    try {
      await fsp.access(to);
      continue; // 目标已存在，不动老目录
    } catch {
      /* 目标不存在，可以改名 */
    }
    try {
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.rename(from, to);
      moved.push({ from: entry.name, to: toRel });
    } catch {
      /* 保持原样 */
    }
  }
  return moved;
}

function taskId(repo, file) {
  return createHash("sha1").update(`${repo}::${file}`).digest("hex").slice(0, 12);
}

function serialize(task) {
  return {
    id: task.id,
    repo: task.repo,
    file: task.file,
    dest: task.dest,
    size: task.size || 0,
    downloaded: task.downloaded || 0,
    progress: task.size ? Math.min(1, (task.downloaded || 0) / task.size) : 0,
    speed: task.speed || 0,
    eta: task.speed > 0 && task.size ? Math.max(0, (task.size - task.downloaded) / task.speed) : null,
    status: task.status,
    error: task.error || null,
    engine: task.engine || null,
    retryAttempt: task._attempts || 0,
    verifying: !!task._verifying,
    retryMax: MAX_AUTO_RETRIES,
    createdAt: task.createdAt,
    startedAt: task.startedAt || null,
    finishedAt: task.finishedAt || null,
  };
}

function emit(type, extra) {
  const payload = extra ?? {};
  const data = JSON.stringify({ type, ...payload, tasks: getTasks() });
  for (const res of clients) {
    try {
      res.write(`data: ${data}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}

export function subscribe(req, res) {
  clients.add(res);
  res.write(`data: ${JSON.stringify({ type: "snapshot", tasks: getTasks() })}\n\n`);
  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* ignore */
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

export function getTasks() {
  return [...tasks.values()].map(serialize).sort((a, b) => a.createdAt - b.createdAt);
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const id = queue.shift();
    const task = tasks.get(id);
    if (!task || task.status !== "queued") continue;
    running++;
    runTask(task).finally(() => {
      running--;
      pump();
    });
  }
}

/** 从错误消息里提取 HTTP 状态码（runTask 抛出的格式为 "HTTP 503 ..."） */
function httpStatusOf(err) {
  const m = /HTTP (\d{3})/.exec(String(err?.message || ""));
  return m ? Number(m[1]) : null;
}

/** 是否为可自动重试的瞬态网络错误（5xx / 429 / 连接中断 / 超时等；4xx 不重试） */
function isTransientError(err, { stalled = false } = {}) {
  if (stalled) return true;
  const status = httpStatusOf(err);
  if (status) return status >= 500 || status === 429;
  const code = err?.cause?.code || err?.code;
  if (
    code &&
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EPIPE",
      "EAI_AGAIN",
      "ENOTFOUND",
      "UND_ERR_SOCKET",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
    ].includes(code)
  ) {
    return true;
  }
  return /terminated|socket hang up|fetch failed|network|timeout|ECONNRESET/i.test(
    `${err?.message || ""} ${err?.cause?.message || ""}`,
  );
}

/** 把底层网络错误翻译成用户能看懂的消息 */
function describeNetworkError(err) {
  const status = httpStatusOf(err);
  if (status === 429) return "被服务器限流（HTTP 429）";
  if (status) return `服务器错误（HTTP ${status}）`;
  const code = err?.cause?.code || err?.code;
  const byCode = {
    ECONNRESET: "连接被重置（网络中断）",
    ECONNREFUSED: "连接被拒绝",
    ETIMEDOUT: "连接超时",
    EPIPE: "连接已断开",
    EAI_AGAIN: "DNS 解析失败",
    ENOTFOUND: "域名解析失败",
    UND_ERR_SOCKET: "网络连接中断",
    UND_ERR_HEADERS_TIMEOUT: "等待响应头超时",
    UND_ERR_BODY_TIMEOUT: "数据传输超时",
  };
  if (code && byCode[code]) return byCode[code];
  const msg = String(err?.message || err || "下载失败");
  if (/terminated/i.test(msg)) return "网络连接中断";
  if (/fetch failed/i.test(msg)) {
    return err?.cause?.message ? `网络请求失败：${err.cause.message}` : "网络请求失败";
  }
  return msg;
}

/** 安排一次自动重试：到期后任务重新入队（若期间被取消 / 删除则跳过） */
function scheduleRetry(task, delay) {
  clearTimeout(task._retryTimer);
  task._retryTimer = setTimeout(() => {
    if (tasks.get(task.id) !== task || task.status !== "retrying") return;
    task.status = "queued";
    task._retryTimer = null;
    emit("update");
    queue.push(task.id);
    pump();
  }, delay);
}

/** 决定用哪个下载引擎：Xet（Rust hf-xet 子进程）还是 fetch（Node fetch） */
async function chooseEngine(task) {
  task.engine = null;
  task._xetMeta = null;
  if (DOWNLOAD_ENGINE === "fetch") return "fetch";
  // 两个引擎都能续传，所以只要 Xet 可用就优先用它（快 2 倍以上）
  const bin = xetBin();
  const meta = bin ? await xetFileMeta(task.repo, task.file) : { hash: "", size: 0 };
  if (!bin || !meta.hash) {
    if (DOWNLOAD_ENGINE === "xet") {
      throw new Error("Xet 引擎不可用（找不到 native/bin/xet-dl，或该文件不在 Xet 存储中）");
    }
    return "fetch";
  }
  task._xetMeta = meta;
  if (meta.size) task.size = meta.size;
  return "xet";
}

/** fetch 引擎：Node 单连接 + `Range` 续传（只有这条路支持续传） */
async function downloadWithFetch(task, existing) {
  const controller = new AbortController();
  task._controller = controller;

  const headers = { ...authHeaders() };
  if (existing > 0) headers.Range = `bytes=${existing}-`;

  // 响应头超时：请求挂起（不发数据也不断开）时也能按时失败并自动重试
  let headersTimer = null;
  let signal = controller.signal;
  if (typeof AbortSignal.any === "function") {
    const headersAbort = new AbortController();
    headersTimer = setTimeout(() => {
      task._headersTimedOut = true;
      headersAbort.abort();
    }, HEADERS_TIMEOUT);
    signal = AbortSignal.any([controller.signal, headersAbort.signal]);
  }

  let res;
  try {
    res = await fetch(resolveUrl(task.repo, task.file), {
      headers,
      signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(headersTimer);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText || ""}`.trim());
  }

  let append = false;
  let total = 0;
  let sizeFromResponse = false;
  if (res.status === 206) {
    append = existing > 0;
    const range = res.headers.get("content-range") || "";
    const m = /\/(\d+)\s*$/.exec(range);
    if (m) {
      total = Number(m[1]);
      sizeFromResponse = true;
    }
    if (!total) {
      const len = Number(res.headers.get("content-length") || 0);
      if (len) {
        total = existing + len;
        sizeFromResponse = true;
      }
    }
  } else {
    total = Number(res.headers.get("content-length") || 0);
    sizeFromResponse = total > 0;
  }
  if (total > 0) task.size = total;
  else if (!task.size) task.size = 0;

  const startBytes = append ? existing : 0;
  task.downloaded = startBytes;
  task._lastBytes = startBytes;
  task._lastAt = Date.now();
  task._stallAt = Date.now();
  task._startBytes = startBytes;
  task._attemptAt = Date.now();

  if (!append && existing > 0) {
    // 服务器忽略了 Range，只能从头写
    existing = 0;
  }

  const counter = new Transform({
    transform(chunk, _enc, cb) {
      task.downloaded += chunk.length;
      task._stallAt = Date.now();
      task._dirty = true;
      cb(null, chunk);
    },
  });

  await pipeline(
    Readable.fromWeb(res.body),
    counter,
    fs.createWriteStream(task.dest, { flags: append ? "a" : "w" }),
  );

  if (!sizeFromResponse) {
    // 响应没有给出可靠长度（chunked 等），以实际写入字节数为准
    task.size = task.downloaded;
  } else if (task.size && task.downloaded !== task.size) {
    throw new Error(`文件大小不一致（期望 ${task.size}，实际 ${task.downloaded}）`);
  }

  task.status = "done";
  task.speed = 0;
  task.eta = null;
  task._attempts = 0;
  task.finishedAt = Date.now();
  emit("update");
}

/** Xet 引擎：起 Rust 子进程多连接下载，stdout 是 NDJSON 进度（支持真续传） */
async function downloadWithXet(task, existing = 0) {
  const meta = task._xetMeta;
  const bin = xetBin();
  const tmp = task.dest + XET_TMP_SUFFIX;
  const statePath = xetStatePath(tmp);

  // 续传：tmp 里有上一轮 Xet 的中断产物就直接接着下；如果只有 dest 里有内容（上一轮是
  // fetch 下的，或用户手动放的半成品），把它改名成 tmp 当种子 —— 改名是零拷贝，不复制几十 GB。
  let tmpSize = 0;
  try {
    tmpSize = (await fsp.stat(tmp)).size;
  } catch {
    tmpSize = 0;
  }
  let seeded = 0;
  if (existing > tmpSize) {
    try {
      await fsp.rename(task.dest, tmp);
      seeded = existing; // 这份前缀是完整下载下来的字节，声明为可信
    } catch {
      /* 改名失败（跨文件系统等）就放弃种子，从 0 开始 */
    }
  }
  const resumeFrom = Math.max(tmpSize, seeded);
  task._verifying = false;

  return new Promise((resolve, reject) => {
    let settled = false;
    let killedByController = false;
    let xetError = null;
    let xetCorrupt = false; // 子进程判定文件已坏（长度不符 / sha256 不匹配）
    let stdoutBuf = "";

    const args = [
      "--xet-hash",
      meta.hash,
      "--file-size",
      String(meta.size || task.size || 0),
      "--dest",
      tmp,
      "--token-refresh-url",
      xetReadTokenUrl(task.repo),
      "--progress-interval-ms",
      String(TICK_MS),
    ];
    if (meta.sha256) args.push("--sha256", meta.sha256);
    // 始终带 --resume：tmp 为空时起点自然是 0，行为与全量下载一致
    args.push("--resume", "--meta", statePath);
    if (seeded > 0) args.push("--trust-prefix", String(seeded));
    const token = getToken();
    if (token) args.push("--auth-token", token);

    // 内存预算 + 高性能开关由前端设置面板控制（只影响新任务）：
    // 开 → 显式把 HF_XET_HIGH_PERFORMANCE / XET_KEEP_HIGH_PERFORMANCE 传下去；
    // 关 → 从子进程环境里删掉，避免用户 shell 里的 export 悄悄把并发和内存拉爆。
    const env = { ...process.env };
    if (getXetHighPerformance()) {
      env.HF_XET_HIGH_PERFORMANCE = "1";
      env.XET_KEEP_HIGH_PERFORMANCE = "1";
    } else {
      delete env.HF_XET_HIGH_PERFORMANCE;
      delete env.HF_XET_HP;
      delete env.XET_KEEP_HIGH_PERFORMANCE;
    }
    env.XET_MEMORY_BUDGET_MB = String(getXetMemoryBudgetMb());

    const child = spawn(bin, args, {
      // 其余内存 / 并发上限交给 xet-dl 自己按预算设默认值，这里只透传调用方显式设置的 HF_XET_* 变量。
      env,
    });
    task._xetChild = child;
    // 伪装成 AbortController：暂停 / 取消 / 卡死看门狗都通过 task._controller.abort() 中断
    task._controller = {
      abort() {
        killedByController = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      },
    };

    // 起点先按本地已有字节显示，子进程的 start 消息回来后会被权威值覆盖
    task.downloaded = resumeFrom;
    task._lastBytes = resumeFrom;
    task._startBytes = resumeFrom;
    task._lastAt = Date.now();
    task._stallAt = Date.now();
    task._stallTimeout = XET_STALL_TIMEOUT;
    task._attemptAt = Date.now();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "start") {
          // 子进程算出来的续传起点是权威值（它会截断到对齐位置，可能比本地长度小）
          if (msg.total) task.size = msg.total;
          task.downloaded = typeof msg.bytes === "number" ? msg.bytes : 0;
          task._startBytes = msg.resumeFrom ?? task.downloaded;
          task._lastBytes = task.downloaded;
          task._lastAt = Date.now();
          task._stallAt = Date.now();
          task._samples = null;
          emit("update");
        } else if (msg.type === "progress" || msg.type === "heartbeat") {
          if (msg.total) task.size = msg.total;
          if (typeof msg.bytes === "number" && msg.bytes > (task.downloaded || 0)) {
            task.downloaded = msg.bytes;
            task._stallAt = Date.now();
            task._dirty = true;
          }
        } else if (msg.type === "verifying") {
          // 续传完成后整体 sha256（Xet 的 range 重建不校验 sha256，必须自己兜底）
          task._verifying = true;
          task._stallAt = Date.now();
        } else if (msg.type === "error") {
          xetError = new Error(msg.message || "Xet 下载失败");
          if (msg.corrupt) xetCorrupt = true;
        }
      }
    });
    child.stderr.resume(); // 丢弃，避免管道塞满卡住子进程

    const cleanup = () => {
      task._xetChild = null;
      task._controller = null;
      task._stallTimeout = null;
    };

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();

      const finish = async () => {
        if (!xetError && code !== 0) {
          xetError = new Error(
            `Xet 下载进程退出（code=${code}${signal ? ` signal=${signal}` : ""}）`,
          );
        }
        if (xetError) {
          if (xetCorrupt) {
            // 文件已坏（长度不符 / sha256 不匹配）：半成品没有续传价值，删掉重来
            await fsp.rm(tmp, { force: true }).catch(() => {});
            await fsp.rm(statePath, { force: true }).catch(() => {});
            task.downloaded = 0;
          }
          if (task._pausing) throw abortError("已暂停");
          if (task._stalled) {
            throw new Error(
              `连接停滞（${Math.round((XET_STALL_TIMEOUT || STALL_TIMEOUT) / 1000)} 秒没有收到数据）`,
            );
          }
          if (killedByController) throw abortError("已取消");
          if (DOWNLOAD_ENGINE !== "xet" && !xetCorrupt && resumeFrom === 0 && (task.downloaded || 0) === 0) {
            // auto 模式：Xet 完全没跑起来（认证 / 协议问题）就回退 fetch，别让下载直接失败
            if (seeded > 0) await fsp.rename(tmp, task.dest).catch(() => {});
            task.engine = "fetch";
            task._xetMeta = null;
            return downloadWithFetch(task, seeded || 0);
          }
          throw xetError;
        }

        const st = await fsp.stat(tmp);
        if (task.size && st.size !== task.size) {
          await fsp.rm(tmp, { force: true }).catch(() => {});
          await fsp.rm(statePath, { force: true }).catch(() => {});
          task.downloaded = 0;
          throw new Error(`文件大小不一致（期望 ${task.size}，实际 ${st.size}）`);
        }
        await fsp.rename(tmp, task.dest);
        await fsp.rm(statePath, { force: true }).catch(() => {});
        task.downloaded = st.size;
        task.size = st.size;
        task.status = "done";
        task.speed = 0;
        task.eta = null;
        task._attempts = 0;
        task._verifying = false;
        task.finishedAt = Date.now();
        emit("update");
      };

      // 注意：失败时不再无条件删 tmp —— 暂停 / 取消 / 停滞 / 网络错误都要留着前缀，
      // 下一轮接着下。删不删由 finish() 里按 corrupt 判定。
      finish().then(resolve, reject);
    });
  });
}


async function runTask(task) {
  task.status = "running";
  task.startedAt = Date.now();
  task.finishedAt = null;
  task.error = null;
  task._samples = null;
  emit("update");

  try {
    await fsp.mkdir(path.dirname(task.dest), { recursive: true });

    let existing = 0;
    try {
      existing = (await fsp.stat(task.dest)).size;
    } catch {
      existing = 0;
    }

    if (task.size && existing > task.size) {
      await fsp.rm(task.dest, { force: true });
      existing = 0;
    }

    if (task.size && existing === task.size) {
      task.downloaded = existing;
      task.size = existing;
      task.status = "done";
      task.finishedAt = Date.now();
      emit("update");
      return;
    }

    // 选择下载引擎：Xet（Rust 子进程，多连接）或 fetch（Node 单连接）；两条路都能续传
    task.engine = await chooseEngine(task);
    if (task.engine === "xet") {
      await downloadWithXet(task, existing);
      return;
    }

    await downloadWithFetch(task, existing);

  } catch (err) {
    const aborted = err?.name === "AbortError";

    if (aborted && task._pausing) {
      // 用户暂停
      task.status = "paused";
      task.speed = 0;
      task.error = null;
      task.finishedAt = Date.now();
    } else if (aborted && !task._stalled && !task._headersTimedOut) {
      // 用户取消
      task.status = "canceled";
      task.speed = 0;
      task.error = null;
      task.finishedAt = Date.now();
    } else {
      // 网络失败（连接中断 / 卡死看门狗 / 响应头超时 / 服务器错误）
      task.speed = 0;
      const message = task._stalled
        ? `连接停滞（${Math.round((task._stallTimeout || STALL_TIMEOUT) / 1000)} 秒没有收到数据）`
        : task._headersTimedOut
          ? `等待响应头超时（${Math.round(HEADERS_TIMEOUT / 1000)} 秒）`
          : describeNetworkError(err);

      if (isTransientError(err, { stalled: task._stalled }) && (task._attempts || 0) < MAX_AUTO_RETRIES) {
        task._attempts = (task._attempts || 0) + 1;
        task.status = "retrying";
        task.error = message;
        task.finishedAt = null;
        scheduleRetry(task, RETRY_BASE_DELAY * 2 ** (task._attempts - 1));
      } else {
        task.status = "error";
        task.error = task.downloaded
          ? `${message}（已下载部分保留，重试会接着下）`
          : message;
        task.finishedAt = Date.now();
      }
    }
    emit("update");
  } finally {
    if (task._xetChild) {
      try {
        task._xetChild.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      task._xetChild = null;
    }
    task._stallTimeout = null;
    task._controller = null;
    task._pausing = false;
    task._stalled = false;
    task._headersTimedOut = false;
    task._stallAt = null;
    task._dirty = false;
  }
}

/** 开始（或续传）一个下载任务 */
export function startDownload({ repo, file, size }) {
  if (!repo || !file) throw new Error("缺少 repo 或 file 参数");
  const id = taskId(repo, file);
  const existingTask = tasks.get(id);

  if (existingTask && ["queued", "running", "retrying"].includes(existingTask.status)) {
    return serialize(existingTask);
  }

  const task = {
    id,
    repo,
    file,
    dest: destinationFor(repo, file),
    size: Number(size) || existingTask?.size || 0,
    downloaded: existingTask?.downloaded || 0,
    speed: 0,
    eta: null,
    status: "queued",
    error: null,
    createdAt: existingTask?.createdAt || Date.now(),
    startedAt: null,
    finishedAt: null,
    _controller: null,
    _attempts: 0,
  };

  // 已下载完成且大小匹配，直接返回
  tasks.set(id, task);
  queue.push(id);
  emit("update");
  pump();
  return serialize(task);
}

export function cancelDownload(id) {
  const task = tasks.get(id);
  if (!task) throw new Error("任务不存在");
  if (task.status === "queued" || task.status === "retrying") {
    task.status = "canceled";
    task.finishedAt = Date.now();
  } else if (task.status === "running") {
    task._controller?.abort();
  } else if (task.status === "paused") {
    task.status = "canceled";
    task.finishedAt = Date.now();
  }
  emit("update");
  return serialize(task);
}

/** 暂停任务：排队中 / 等待重试的直接挂起，下载中的中断连接；都保留已下载分片 */
export function pauseDownload(id) {
  const task = tasks.get(id);
  if (!task) throw new Error("任务不存在");
  if (task.status === "queued" || task.status === "retrying") {
    task.status = "paused";
    task.speed = 0;
    task.finishedAt = Date.now();
    const idx = queue.indexOf(id);
    if (idx >= 0) queue.splice(idx, 1);
  } else if (task.status === "running") {
    task._pausing = true;
    task._controller?.abort();
  } else if (task.status !== "paused") {
    throw new Error("任务当前状态不支持暂停");
  }
  emit("update");
  return serialize(task);
}

/** 继续已暂停的任务：重新入队，两个引擎都从已下载位置接着下 */
export function resumeDownload(id) {
  const task = tasks.get(id);
  if (!task) throw new Error("任务不存在");
  if (task.status !== "paused") throw new Error("任务不在暂停状态");
  task.status = "queued";
  task.error = null;
  task.finishedAt = null;
  task._attempts = 0;
  queue.push(id);
  emit("update");
  pump();
  return serialize(task);
}

/** 暂停全部排队中 / 等待重试 / 下载中的任务 */
export function pauseAllDownloads() {
  for (const task of [...tasks.values()]) {
    if (["queued", "running", "retrying"].includes(task.status)) pauseDownload(task.id);
  }
}

/** 继续全部已暂停的任务 */
export function resumeAllDownloads() {
  for (const task of [...tasks.values()]) {
    if (task.status === "paused") resumeDownload(task.id);
  }
}

export function removeDownload(id, { deleteFile = false } = {}) {
  const task = tasks.get(id);
  if (!task) return false;
  if (task.status === "running") task._controller?.abort();
  tasks.delete(id);
  const idx = queue.indexOf(id);
  if (idx >= 0) queue.splice(idx, 1);
  const tmp = task.dest + XET_TMP_SUFFIX;
  if (deleteFile) {
    // 连文件一起删：成品、半成品、续传状态一起清掉
    fsp.rm(task.dest, { force: true }).catch(() => {});
    fsp.rm(tmp, { force: true }).catch(() => {});
    fsp.rm(xetStatePath(tmp), { force: true }).catch(() => {});
  }
  // 只移除任务：半成品留着，下次下载同一文件会接着下
  emit("update");
  return true;
}

/** 已存在的本地文件（用于展示“已下载 / 部分”状态） */
export async function localFileInfo(repo, file) {
  const dest = destinationFor(repo, file);
  // Xet 的半成品（可续传）写在 <dest>.xet-partial，也要能被列出来
  for (const candidate of [dest, dest + XET_TMP_SUFFIX]) {
    try {
      const st = await fsp.stat(candidate);
      return { exists: true, size: st.size, dest: candidate };
    } catch {
      /* 试下一个候选路径 */
    }
  }
  return { exists: false, size: 0, dest };
}

export async function diskFree() {
  try {
    await fsp.mkdir(getDownloadDir(), { recursive: true });
    const st = await fsp.statfs(getDownloadDir());
    return { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
  } catch {
    return { free: 0, total: 0 };
  }
}

/** 删除本地文件后，把指向它的任务记录一并清掉 */
export function forgetTasksByDest(absPath) {
  let changed = false;
  for (const [id, task] of tasks) {
    if (task.dest === absPath || task.dest.startsWith(absPath + path.sep)) {
      if (task.status === "running") task._controller?.abort();
      tasks.delete(id);
      const idx = queue.indexOf(id);
      if (idx >= 0) queue.splice(idx, 1);
      changed = true;
    }
  }
  if (changed) emit("update");
  return changed;
}

// 统一的速度/进度广播，避免每个 chunk 都推一次 SSE；顺带做卡死看门狗
setInterval(() => {
  const now = Date.now();
  let dirty = false;
  for (const task of tasks.values()) {
    if (task.status !== "running") continue;

    // 长时间收不到任何字节：主动中断，交给 runTask 的 catch 走自动重试
    const stallLimit = task._stallTimeout || STALL_TIMEOUT;
    if (task._controller && task._stallAt && now - task._stallAt > stallLimit) {
      task._stalled = true;
      try {
        task._controller.abort();
      } catch {
        /* ignore */
      }
      continue;
    }

    const last = task._lastAt || now;
    const dt = (now - last) / 1000;
    if (dt <= 0) continue;
    const delta = (task.downloaded || 0) - (task._lastBytes || 0);
    if (task.engine === "xet") {
      // Xet 一次落几十 MB，瞬时值会在「几十 MB/s」和「0」之间来回跳，
      // 所以速度取最近 XET_SPEED_WINDOW 时间窗口内的平均增量。
      const samples = task._samples || (task._samples = []);
      samples.push({ at: now, bytes: task.downloaded || 0 });
      while (samples.length > 2 && now - samples[0].at > XET_SPEED_WINDOW) samples.shift();
      const first = samples[0];
      const windowSec = (now - first.at) / 1000;
      const windowAvg =
        windowSec >= 2 ? Math.max(0, (task.downloaded || 0) - first.bytes) / windowSec : 0;
      // 兜底：本次尝试以来的总均值。Xet 落盘是跳变的（单项几十～几百 MB），
      // 短窗口里经常刚好没有增量，速度会变成 0、前端渲染成「—」，看着像没在下。
      const sinceSec = Math.max(1, (now - (task._attemptAt || task.startedAt || now)) / 1000);
      const overallAvg = Math.max(0, (task.downloaded || 0) - (task._startBytes || 0)) / sinceSec;
      if (windowAvg > 0 || overallAvg > 0) task.speed = windowAvg > 0 ? windowAvg : overallAvg;
    } else {
      const instant = delta / dt;
      task.speed = task.speed ? task.speed * 0.6 + instant * 0.4 : instant;
    }
    task._lastBytes = task.downloaded || 0;
    task._lastAt = now;
    if (task.size) task.eta = task.speed > 0 ? (task.size - task.downloaded) / task.speed : null;
    dirty = true;
  }
  if (dirty) emit("tick");
}, TICK_MS);

export { ENDPOINT };
