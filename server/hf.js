import { listModels, listFiles, modelInfo } from "@huggingface/hub";

/** 镜像站地址，可用 HF_ENDPOINT 覆盖（例如 https://huggingface.co） */
export const ENDPOINT = (process.env.HF_ENDPOINT || "https://hf-mirror.com").replace(/\/+$/, "");

/* ------------------------------ 访问令牌 ------------------------------
 * 可选，私有 / 门控仓库需要。可以在界面上点顶部「令牌」芯片配置（写进 settings.json），
 * 也可以在启动时用 HF_TOKEN / HF_ACCESS_TOKEN 指定。优先级：
 *   settings.json 里有 hfToken 字段（哪怕是空串 = 明确不用令牌） > 环境变量。
 * 对外一律只给掩码（maskToken），任何接口都不会回传完整令牌。
 */
import { loadSettings, saveSettings } from "./settings.js";

const ENV_TOKEN = (process.env.HF_TOKEN || process.env.HF_ACCESS_TOKEN || "").trim();
const storedToken = loadSettings().hfToken;
const hasStoredToken = typeof storedToken === "string";

let token = String(hasStoredToken ? storedToken : ENV_TOKEN).trim();
// settings = 界面上配置的 / cleared = 界面上明确清掉过（环境变量也不再采用）/ env = 环境变量 / none
let tokenSource = hasStoredToken ? (token ? "settings" : "cleared") : token ? "env" : "none";

export function getToken() {
  return token;
}

/** hf_a1b2…z9Yw（37 位）——只用于展示，绝不返回原文 */
export function maskToken(value) {
  const t = String(value || "");
  if (!t) return "";
  if (t.length <= 12) return `${t.slice(0, 3)}…（${t.length} 位）`;
  return `${t.slice(0, 7)}…${t.slice(-4)}（${t.length} 位）`;
}

export function tokenStatus() {
  return { hasToken: Boolean(token), source: tokenSource, hint: maskToken(token) };
}

/** 保存 / 清除令牌。传空串表示「明确不用令牌」，此后连 HF_TOKEN 环境变量也忽略。 */
export function setToken(value) {
  const next = String(value ?? "").trim();
  saveSettings({ hfToken: next });
  token = next;
  tokenSource = next ? "settings" : "cleared";
  return tokenStatus();
}

/**
 * 向镜像站校验令牌（/api/whoami-v2）。
 * 返回 { ok: true, user } / { ok: false, status }（明确无效）/ { ok: null }（网络异常，调用方可放行）。
 */
export async function verifyToken(value) {
  const t = String(value ?? "").trim();
  if (!t) return { ok: true, user: null };
  let res;
  try {
    res = await fetch(`${ENDPOINT}/api/whoami-v2`, {
      headers: { Authorization: `Bearer ${t}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return { ok: null, error: err?.message || String(err) };
  }
  if (res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: true, user: body?.name || body?.fullname || null };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, status: res.status };
  return { ok: null, status: res.status };
}

/** 令牌变了就丢掉缓存的 README / 文件指纹，否则门控仓库会继续按「无令牌」的结果显示 */
export function clearHfCaches() {
  readmeCache.clear();
}

function credentials() {
  return token ? { accessToken: token } : {};
}

export function authHeaders() {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** 文件直链（hf-mirror 的 /resolve 接口，自动 302 到 CDN） */
export function resolveUrl(repo, file, revision = "main") {
  const encodedRepo = repo
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const encodedFile = file
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `${ENDPOINT}/${encodedRepo}/resolve/${encodeURIComponent(revision)}/${encodedFile}`;
}

/** README 原始文件地址：/resolve 在镜像站对普通文本直接返回内容，对 LFS 文件会 302 到 CDN */
export function rawUrl(repo, file, revision = "main") {
  return resolveUrl(repo, file, revision);
}

const README_CANDIDATES = ["README.md", "README.markdown", "readme.md"];
const README_MAX_BYTES = 2 * 1024 * 1024;
const README_TTL = 10 * 60 * 1000;
const readmeCache = new Map();

/** 读取仓库 README（模型卡片）的 Markdown 原文 */
export async function getReadme(repo, { force = false } = {}) {
  const hit = readmeCache.get(repo);
  if (!force && hit && Date.now() - hit.at < README_TTL) return hit.data;

  let lastError = null;

  for (const file of README_CANDIDATES) {
    let res;
    try {
      res = await fetch(rawUrl(repo, file), {
        headers: { Accept: "text/plain, text/markdown, */*", ...authHeaders() },
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      lastError = err;
      continue;
    }

    if (res.status === 404) continue;
    if (!res.ok) {
      lastError = new Error(`HTTP ${res.status}`);
      continue;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > README_MAX_BYTES) {
      throw new Error("README 超过 2 MB，请到镜像站查看");
    }

    const content = buffer.toString("utf8");
    const data = {
      repo,
      file,
      content,
      missing: false,
      url: `${ENDPOINT}/${repo}/blob/main/${file}`,
    };

    rememberReadme(repo, data);
    return data;
  }

  const data = {
    repo,
    file: null,
    content: "",
    missing: true,
    url: `${ENDPOINT}/${repo}`,
    error: lastError?.message || null,
  };
  rememberReadme(repo, data);
  return data;
}

function rememberReadme(repo, data) {
  readmeCache.set(repo, { at: Date.now(), data });
  if (readmeCache.size > 20) {
    const oldest = readmeCache.keys().next().value;
    if (oldest !== undefined) readmeCache.delete(oldest);
  }
}

function mapModel(m, fallbackId) {
  // 注意：@huggingface/hub 里 `name` 才是仓库名，`id` 是内部 _id
  const id =
    fallbackId ||
    (typeof m.name === "string" && m.name.includes("/") ? m.name : m.id);
  const tags = Array.isArray(m.tags) ? m.tags : [];
  const licenseTag = tags.find((t) => typeof t === "string" && t.startsWith("license:"));
  const baseTag = tags.find((t) => typeof t === "string" && t.startsWith("base_model:"));

  const baseModel =
    m.cardData?.base_model ??
    (baseTag ? baseTag.slice("base_model:".length) : null);

  // cardData.base_model 可能是字符串或数组；也兼容 tags 里的 base_model:xxx
  const baseModels = (Array.isArray(baseModel) ? baseModel : [baseModel])
    .flatMap((v) => String(v ?? "").split(","))
    .map((v) => v.trim())
    .filter(Boolean);

  return {
    id,
    author:
      m.author ||
      (typeof id === "string" && id.includes("/") ? id.split("/")[0] : null),
    downloads: m.downloads ?? 0,
    likes: m.likes ?? 0,
    lastModified: m.lastModified ?? m.updatedAt ?? null,
    createdAt: m.createdAt ?? null,
    tags,
    pipeline: m.pipeline_tag ?? m.task ?? null,
    library: m.library_name ?? null,
    license: m.cardData?.license ?? (licenseTag ? licenseTag.slice(8) : null),
    baseModel: baseModels.join(", ") || null,
    baseModels,
    sha: m.sha ?? null,
    usedStorage: m.usedStorage ?? null,
    gated: Boolean(m.gated),
    private: Boolean(m.private),
  };
}

/**
 * 搜索模型。
 * @param {{query?: string, sort?: string, limit?: number, author?: string}} opts
 */
export async function searchModels({ query = "", sort = "downloads", limit = 30, author } = {}) {
  const q = query.trim();
  const sortValue = ["downloads", "likes", "lastModified", "createdAt", "trendingScore"].includes(sort)
    ? sort
    : "downloads";

  const iterator = listModels({
    hubUrl: ENDPOINT,
    limit,
    sort: sortValue,
    search: {
      query: q || undefined,
      owner: author || undefined,
    },
    additionalFields: ["tags", "createdAt", "author"],
    ...credentials(),
  });

  const models = [];
  for await (const m of iterator) {
    models.push(mapModel(m));
    if (models.length >= limit) break;
  }
  return models;
}

/** 单个模型的基本信息（用于直接粘贴 repo id 时校验） */
export async function getModel(repo) {
  try {
    const info = await modelInfo({
      name: repo,
      hubUrl: ENDPOINT,
      additionalFields: [
        "tags",
        "createdAt",
        "author",
        "cardData",
        "library_name",
        "sha",
        "usedStorage",
      ],
      ...credentials(),
    });
    if (!info) return null;
    return mapModel(info, repo);
  } catch {
    return null;
  }
}

/**
 * 列出仓库所有文件及大小（递归、自动翻页）。
 * @param {string} repo
 * @param {string} revision
 */
export async function listRepoFiles(repo, revision = "main") {
  const files = [];
  let totalSize = 0;

  for await (const entry of listFiles({
    repo,
    hubUrl: ENDPOINT,
    recursive: true,
    revision,
    ...credentials(),
  })) {
    if (entry.type !== "file") continue;
    const size = Number(entry.size) || 0;
    totalSize += size;
    files.push({
      path: entry.path,
      size,
      lfs: Boolean(entry.lfs),
      oid: entry.oid,
    });
  }

  // HF 返回顺序不固定，按路径排序更好读
  files.sort((a, b) => a.path.localeCompare(b.path, "en", { numeric: true }));
  return { repo, revision, files, totalSize, count: files.length };
}
