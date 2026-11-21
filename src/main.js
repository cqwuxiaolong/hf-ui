/* HF 模型管理器 —— 前端逻辑 */

import { marked } from "marked";
import DOMPurify from "dompurify";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  config: null,
  models: [],
  repo: null,
  model: null,
  files: [],
  totalSize: 0,
  fileFilter: "",
  selected: new Set(),
  tasks: new Map(), // key: repo::file
  loadingFiles: false,
  searchSeq: 0,
  tab: "tasks",
  local: { dir: "", groups: [], totalSize: 0, count: 0 },
  localLoaded: false,
  localLoading: false,
};

const els = {
  meta: $("#topbar-meta"),
  form: $("#search-form"),
  q: $("#q"),
  history: $("#search-history"),
  sort: $("#sort"),
  limit: $("#limit"),
  results: $("#results"),
  detail: $("#detail"),
  layout: $("#layout"),
  rail: $("#rail"),
  railBody: $("#rail-body"),
  railFoot: $("#rail-foot"),
  railToggle: $("#rail-toggle"),
  railLauncher: $("#rail-launcher"),
  railBadge: $("#rail-badge"),
  taskBadge: $("#task-badge"),
  dirInput: $("#dir-input"),
  dirMeta: $("#dir-meta"),
  xetHp: $("#xet-hp"),
  xetBudget: $("#xet-budget"),
  xetMeta: $("#xet-meta"),
  toast: $("#toast"),
  dirModal: $("#dir-modal"),
  fsRoots: $("#fs-roots"),
  fsPath: $("#fs-path"),
  fsCrumbs: $("#fs-crumbs"),
  fsList: $("#fs-list"),
  fsCurrent: $("#fs-current-path"),
  fsDisk: $("#fs-disk"),
  fsShowHidden: $("#fs-show-hidden"),
};

/* ------------------------------ 工具函数 ------------------------------ */

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1000) return `${n} B`;
  let i = 0;
  let v = n;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  const digits = v >= 100 ? 1 : 2;
  return `${v.toFixed(digits)} ${UNITS[i]}`;
}

function fmtSpeed(bytes) {
  if (!bytes || bytes <= 0) return "—";
  return `${fmtBytes(bytes)}/s`;
}

/**
 * 任务卡上的速度文案。
 * Xet 要先把整块缓冲灌满才落盘（实测开头 30~45 秒磁盘上是 0 字节），
 * 这段时间既没有速度也没有进度，直接显示「—」很像卡死，所以单独标成「缓冲中」。
 */
function speedLabel(t) {
  if (t.status !== "running") return "—";
  if (t.speed > 0) return fmtSpeed(t.speed);
  return (t.downloaded || 0) > 0 ? fmtSpeed(t.speed) : "缓冲中…";
}

function fmtEta(sec) {
  if (sec == null || !isFinite(sec) || sec <= 0) return "";
  const s = Math.round(sec);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

const taskKey = (repo, file) => `${repo}::${file}`;

const README_RE = /^readme(\.md|\.markdown|\.txt)?$/i;

let toastTimer;
function toast(msg, ms = 2200) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), ms);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制到剪贴板");
  } catch {
    toast("复制失败，请手动复制");
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
  return data;
}

const STATUS_LABEL = {
  queued: "排队中",
  running: "下载中",
  verifying: "校验中",
  retrying: "重试中",
  paused: "已暂停",
  done: "已完成",
  error: "出错",
  canceled: "已取消",
};

/* ------------------------------ 初始化 ------------------------------ */

async function init() {
  try {
    state.config = await api("/api/config");
  } catch (err) {
    toast(`无法连接后端：${err.message}`, 5000);
  }
  renderMeta();
  updateDirUI();
  updateXetUI();

  let initialTasks = [];
  try {
    const { tasks } = await api("/api/tasks");
    initialTasks = tasks || [];
    setTasks(initialTasks, { silent: true });
  } catch {
    /* ignore */
  }

  // 记住上次的展开状态；首次访问时仅有任务才默认展开
  const savedRail = localStorage.getItem(RAIL_KEY);
  setRail(savedRail ? savedRail === "1" : initialTasks.length > 0, { persist: false });

  connectEvents();
  bindTokenModal();

  const opened = await openHashRepo();
  if (!opened) els.q.focus();
}

function hashRepo() {
  const value = decodeURIComponent(location.hash.replace(/^#repo=/, ""));
  return value.includes("/") ? value : "";
}

async function openHashRepo() {
  const repo = hashRepo();
  if (!repo || repo === state.repo) return false;
  els.q.value = repo;
  // 直接按仓库加载，不依赖搜索接口（镜像站搜索偶发 503 时也能打开）
  await selectModel(repo);
  // 后台补充左侧搜索结果；失败不影响已打开的仓库
  doSearch(repo, true, { autoSelect: false });
  return true;
}

window.addEventListener("hashchange", () => {
  openHashRepo();
});

function renderMeta() {
  const c = state.config;
  if (!c) {
    els.meta.innerHTML = `<span class="meta-chip"><span class="dot" style="background:#ff6b6b;box-shadow:0 0 8px #ff6b6b"></span>后端未连接</span>`;
    return;
  }
  const disk = c.disk || {};
  els.meta.innerHTML = `
    <span class="meta-chip" title="镜像站地址"><span class="dot"></span>${esc(c.endpoint)}</span>
    <span class="meta-chip" title="下载目录所在磁盘剩余空间">剩余 <b>${fmtBytes(disk.free)}</b></span>
    <button class="meta-chip chip-btn" id="token-chip" type="button" title="${
      c.hasToken
        ? `已配置访问令牌（${esc(c.token?.hint || "")}）· 点击可查看 / 更换 / 清除`
        : "未配置访问令牌，只能下载公开仓库 · 点击配置（私有 / 门控仓库需要）"
    }">
      <span class="dot" style="${
        c.hasToken ? "" : "background:#ffb454;box-shadow:0 0 8px rgba(255,180,84,.7)"
      }"></span>${c.hasToken ? "令牌 ✓" : "未配置令牌"}
    </button>
  `;
}

function updateDirUI() {
  const c = state.config;
  if (!c) return;
  if (document.activeElement !== els.dirInput) els.dirInput.value = c.downloadDir || "";
  els.dirInput.title = c.downloadDir || "";
  els.dirMeta.innerHTML = `剩余 <b>${fmtBytes(c.disk?.free)}</b> · 修改后仅影响新任务`;
}

function updateXetUI() {
  const c = state.config;
  if (!c || !els.xetHp) return;
  if (document.activeElement !== els.xetBudget) {
    els.xetBudget.value = c.xetMemoryBudgetMb ?? 1024;
  }
  els.xetHp.checked = Boolean(c.xetHighPerformance);
  els.xetMeta.innerHTML = `当前 <b>${c.xetHighPerformance ? "高性能（并发 124）" : "默认（并发 64）"}</b> · 仅对新任务生效`;
}

function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.tasks) setTasks(data.tasks);
    } catch {
      /* ignore */
    }
  };
}

/* ------------------------------ 搜索 ------------------------------ */

let searchTimer;

els.q.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => doSearch(), 420);
  renderHistory();
});

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  clearTimeout(searchTimer);
  hideHistory();
  doSearch();
});

els.q.addEventListener("focus", renderHistory);
els.q.addEventListener("blur", hideHistory);
// 面板里的点击不能抢走输入框焦点（否则 blur 先触发、面板消失，点击就丢了）
els.history.addEventListener("mousedown", (e) => e.preventDefault());
els.history.addEventListener("click", (e) => {
  const del = e.target.closest("[data-hist-del]");
  if (del) {
    removeHistory(del.dataset.histDel);
    return;
  }
  if (e.target.closest("#history-clear")) {
    if (!loadHistory().length) {
      toast("搜索历史已经是空的");
      return;
    }
    clearHistory();
    toast("已删除全部搜索历史");
    return;
  }
  const item = e.target.closest("[data-hist]");
  if (!item) return;
  els.q.value = item.dataset.hist;
  clearTimeout(searchTimer);
  hideHistory();
  doSearch(item.dataset.hist, true);
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("#search-form")) hideHistory();
});

els.sort.addEventListener("change", () => state.models.length && doSearch(els.q.value, true));
els.limit.addEventListener("change", () => state.models.length && doSearch(els.q.value, true));

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== els.q) {
    e.preventDefault();
    els.q.focus();
    els.q.select();
  }
  if (e.key === "Escape" && document.activeElement === els.q) els.q.blur();
});

/* --------------------------- 搜索历史（localStorage） --------------------------- */

const HISTORY_KEY = "hf.searchHistory";
const HISTORY_MAX = 12;
let lastRemembered = "";

function loadHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(raw)
      ? raw.filter((v) => typeof v === "string" && v.trim()).slice(0, HISTORY_MAX)
      : [];
  } catch {
    return [];
  }
}

function saveHistory(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch {
    /* 隐私模式 / 配额不足：忽略 */
  }
}

function pushHistory(query) {
  const q = String(query ?? "").trim();
  if (!q) return;
  const list = loadHistory().filter((v) => v.toLowerCase() !== q.toLowerCase());
  list.unshift(q);
  saveHistory(list);
  if (document.activeElement === els.q) renderHistory();
}

/** doSearch 会因防抖 / 改排序被反复调用，同一个查询词只记一次 */
function rememberSearchQuery(query) {
  const q = String(query ?? "").trim();
  if (!q || q.toLowerCase() === lastRemembered.toLowerCase()) return;
  lastRemembered = q;
  pushHistory(q);
}

function removeHistory(query) {
  saveHistory(loadHistory().filter((v) => v !== query));
  renderHistory();
}

function clearHistory() {
  saveHistory([]);
  renderHistory();
}

function hideHistory() {
  els.history?.classList.add("hidden");
}

function renderHistory() {
  const box = els.history;
  if (!box) return;
  const needle = els.q.value.trim().toLowerCase();
  const all = loadHistory();
  const shown = (needle ? all.filter((v) => v.toLowerCase().includes(needle)) : all).filter(
    (v) => v.toLowerCase() !== needle,
  );
  if (!shown.length) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `
    <div class="history-head">
      <span>搜索历史</span>
      <button type="button" class="link-btn" id="history-clear">全部删除</button>
    </div>
    ${shown
      .map(
        (v) => `<div class="history-row">
          <button type="button" class="history-item mono" data-hist="${esc(v)}" title="${esc(v)}">${esc(v)}</button>
          <button type="button" class="history-del" data-hist-del="${esc(v)}" title="删除这条历史">✕</button>
        </div>`,
      )
      .join("")}
  `;
  box.classList.remove("hidden");
}

/** 点基础模型：填进搜索框；owner/name 直接打开仓库，否则当关键字搜索 */
function openBaseModel(name) {
  const value = String(name ?? "").trim();
  if (!value) return;
  els.q.value = value;
  hideHistory();
  pushHistory(value);
  // 只有形如 owner/name 才当仓库直接打开；旧版后端可能回传逗号拼接的一整串，那种按关键字搜
  if (/^[^/\s]+\/[^/\s]+$/.test(value)) {
    location.hash = `repo=${encodeURIComponent(value)}`;
    if (hashRepo() === value) openHashRepo();
  } else {
    clearTimeout(searchTimer);
    doSearch(value, true);
  }
}

async function doSearch(rawQuery, force = false, { autoSelect = true } = {}) {
  const q = String(rawQuery ?? els.q.value).trim();
  const seq = ++state.searchSeq;

  if (!q) {
    state.models = [];
    els.results.innerHTML = `<div class="empty small">输入关键字开始搜索，例如 <code>DeepSeek-V4.1-Flash</code></div>`;
    return;
  }

  rememberSearchQuery(q);
  els.results.innerHTML = Array.from({ length: 6 }, () => `<div class="skeleton"></div>`).join("");

  const params = new URLSearchParams({ q, sort: els.sort.value, limit: els.limit.value });

  try {
    const { models } = await api(`/api/search?${params}`);
    if (seq !== state.searchSeq) return;
    state.models = models || [];
    renderResults();

    const shouldAutoSelect =
      autoSelect &&
      state.models.length > 0 &&
      (!state.repo || (force && !state.models.some((m) => m.id === state.repo)));

    if (shouldAutoSelect) {
      selectModel(state.models[0].id);
    } else if (!state.models.length) {
      els.results.innerHTML = `<div class="empty small">没有找到「${esc(q)}」相关的模型</div>`;
    }
  } catch (err) {
    if (seq !== state.searchSeq) return;
    const raw = err.message || "";
    const friendly = /\b(502|503|504)\b/.test(raw)
      ? "镜像站搜索接口暂时不可用，请稍后重试；也可以直接粘贴 owner/name 打开模型。"
      : raw;
    els.results.innerHTML = `<div class="empty small">搜索失败：${esc(friendly)}</div>`;
  }
}

function renderResults() {
  if (!state.models.length) {
    els.results.innerHTML = `<div class="empty small">没有结果</div>`;
    return;
  }

  els.results.innerHTML = state.models
    .map((m) => {
      const [owner, ...rest] = m.id.split("/");
      const name = rest.join("/") || owner;
      const tags = m.tags.filter((t) => !t.includes(":")).slice(0, 3);
      if (m.gated) tags.unshift("gated");
      return `
        <button class="result ${m.id === state.repo ? "active" : ""}" data-repo="${esc(m.id)}">
          <div class="result-top">
            <span class="result-owner">${esc(rest.length ? owner + "/" : "")}</span>
            <span class="result-name">${esc(rest.length ? name : owner)}</span>
          </div>
          <div class="result-meta">
            <span>↓ ${fmtNum(m.downloads)}</span>
            <span>♥ ${fmtNum(m.likes)}</span>
            <span>${fmtDate(m.lastModified)}</span>
          </div>
          ${
            tags.length
              ? `<div class="result-tags">${tags
                  .map((t) => `<span class="tag ${t === "gated" ? "warn" : ""}">${esc(t)}</span>`)
                  .join("")}</div>`
              : ""
          }
        </button>`;
    })
    .join("");
}

els.results.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-repo]");
  if (!btn) return;
  selectModel(btn.dataset.repo);
});

/* ------------------------------ 模型详情 ------------------------------ */

async function selectModel(repo) {
  state.repo = repo;
  pushHistory(repo);
  state.model = state.models.find((m) => m.id === repo) || null;
  state.files = [];
  state.totalSize = 0;
  state.selected.clear();
  state.fileFilter = "";
  state.loadingFiles = true;

  history.replaceState(null, "", `#repo=${encodeURIComponent(repo)}`);
  renderResults();
  renderDetailLoading();

  try {
    const [data, info] = await Promise.all([
      api(`/api/files?repo=${encodeURIComponent(repo)}`),
      api(`/api/model?repo=${encodeURIComponent(repo)}`)
        .then((d) => d.model)
        .catch(() => null),
    ]);
    if (state.repo !== repo) return;
    if (info) state.model = info;
    state.files = data.files || [];
    state.totalSize = data.totalSize || 0;
    state.loadingFiles = false;
    renderDetail();
    syncFileStates();
  } catch (err) {
    if (state.repo !== repo) return;
    state.loadingFiles = false;
    els.detail.innerHTML = `
      <div class="empty big">
        <div class="empty-icon">⚠</div>
        <h2>加载文件列表失败</h2>
        <p>${esc(err.message)}</p>
        <p style="margin-top:6px;color:var(--muted-2)">如果是私有 / 门控仓库，请先在启动时配置 HF_TOKEN。</p>
      </div>`;
  }
}

async function reloadCurrentFiles() {
  if (!state.repo) return;
  try {
    const data = await api(`/api/files?repo=${encodeURIComponent(state.repo)}`);
    if (state.repo !== data.repo) return;
    state.files = data.files || [];
    state.totalSize = data.totalSize || 0;
    renderDetail();
  } catch {
    /* ignore */
  }
}

function renderDetailLoading() {
  els.detail.innerHTML = `
    <div class="detail-head">
      <div>
        <div class="skeleton" style="width:320px;height:26px"></div>
        <div class="skeleton" style="width:440px;height:16px;margin-top:10px"></div>
      </div>
    </div>
    <div class="summary">${Array.from({ length: 4 }, () => `<div class="skeleton" style="height:64px"></div>`).join("")}</div>
    <div class="skeleton" style="height:220px"></div>
    <p class="empty small" style="margin-top:18px"><span class="spinner"></span> 正在读取文件列表与大小…</p>`;
}

function localTotals() {
  let bytes = 0;
  let complete = 0;
  for (const f of state.files) {
    if (f.local) {
      bytes += Math.min(f.local.size, f.size);
      if (f.local.complete) complete++;
    }
  }
  return { bytes, complete };
}

function renderDetail() {
  const repo = state.repo;
  const [owner, ...rest] = repo.split("/");
  const name = rest.join("/");
  const m = state.model || {};
  const { bytes: localBytes, complete: localComplete } = localTotals();
  const disk = state.config?.disk || {};
  const pct = state.totalSize ? (localBytes / state.totalSize) * 100 : 0;
  const hasReadme = state.files.some((f) => README_RE.test(f.path));

  els.detail.innerHTML = `
    <div class="detail-head">
      <div style="min-width:0">
        <h2 class="repo-title"><span class="owner">${esc(owner)}/</span>${esc(name)}</h2>
        <div class="repo-sub">
          <span class="stat hl"><b>${fmtBytes(state.totalSize)}</b> 总大小</span>
          <span class="stat"><b>${state.files.length}</b> 个文件</span>
          <span class="stat">↓ <b>${fmtNum(m.downloads)}</b></span>
          <span class="stat">♥ <b>${fmtNum(m.likes)}</b></span>
          <span class="stat">更新 <b>${fmtDate(m.lastModified)}</b></span>
          ${m.gated ? `<span class="stat" style="color:#ffc861">门控仓库</span>` : ""}
        </div>
      </div>
      <div class="detail-actions">
        ${hasReadme ? `<button class="btn ghost" data-act="readme">▤ README</button>` : ""}
        <button class="btn primary" data-act="download-all">⇩ 下载全部</button>
        <a class="btn ghost" href="${esc(state.config?.endpoint || "https://hf-mirror.com")}/${esc(repo)}" target="_blank" rel="noreferrer">镜像站打开 ↗</a>
        <button class="btn ghost" data-act="copy-repo">复制模型名</button>
      </div>
    </div>

    <div class="summary">
      <div class="summary-card">
        <div class="label">仓库总大小</div>
        <div class="value accent">${fmtBytes(state.totalSize)}</div>
      </div>
      <div class="summary-card">
        <div class="label">本地已下载</div>
        <div class="value">${fmtBytes(localBytes)} <span style="font-size:12px;color:var(--muted)">· ${pct.toFixed(1)}%</span></div>
      </div>
      <div class="summary-card">
        <div class="label">已完成文件</div>
        <div class="value">${localComplete} <span style="font-size:12px;color:var(--muted)">/ ${state.files.length}</span></div>
      </div>
      <div class="summary-card">
        <div class="label">磁盘可用空间</div>
        <div class="value">${fmtBytes(disk.free)}</div>
      </div>
    </div>

    ${repoInfoHtml(m)}

    <div class="table-wrap">
      <div class="table-bar">
        <label style="display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted)">
          <input type="checkbox" id="sel-all" /> 全选
        </label>
        <span class="muted" style="font-size:11.5px" data-role="visible-count">${state.files.length} 个文件</span>
        <span class="spacer"></span>
        <input class="file-filter" id="file-filter" type="search" placeholder="筛选文件，如 .basalt" value="${esc(state.fileFilter)}" />
      </div>
      <div style="overflow:auto;max-height:max(240px,calc(100vh - 520px))">
        <table>
          <colgroup>
            <col style="width:34px" />
            <col />
            <col style="width:104px" />
            <col style="width:140px" />
            <col style="width:132px" />
          </colgroup>
          <thead>
            <tr>
              <th class="check"></th>
              <th>文件</th>
              <th class="num">大小</th>
              <th>状态</th>
              <th class="act">操作</th>
            </tr>
          </thead>
          <tbody id="file-tbody">
            ${state.files.map(fileRowHtml).join("")}
          </tbody>
        </table>
      </div>
      <div class="selbar">
        <label style="display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted)">
          <input type="checkbox" id="sel-all-2" /> 全选
        </label>
        <span class="info" id="sel-info">未选择文件</span>
        <span class="spacer"></span>
        <button class="btn ghost sm" data-act="clear-selection" disabled>清除选择</button>
        <button class="btn primary sm" data-act="download-selected" disabled>⇩ 下载选中</button>
      </div>
    </div>
  `;

  applyFileFilter();
  updateSelectionUI();
}

/** 基础模型：每个名字都是按钮 —— 点击填入搜索框并打开该仓库，Shift+点击复制 */
function baseModelsHtml(m, breakable) {
  const dash = `<span style="color:var(--muted-2)">—</span>`;
  // 后端给数组最好；只有拼接串（含旧版后端）时按逗号 / 分号自己拆开，一个名字一个按钮
  const raw = (m.baseModels || []).length ? m.baseModels : m.baseModel ? [m.baseModel] : [];
  const list = [
    ...new Set(
      raw
        .flatMap((v) => String(v).split(/[,，;；]+/))
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
  if (!list.length) return dash;
  return `<span class="base-models">${list
    .map(
      (name) =>
        `<button class="link-btn mono" data-base-model="${esc(name)}" title="点击填入搜索框并打开 ${esc(
          name,
        )}（Shift+点击复制）">${breakable(name)}</button>`,
    )
    .join(`<span class="bm-sep">,</span>`)}</span>`;
}

function repoInfoHtml(m) {
  const visibility = m.private ? "私有" : m.gated ? "门控" : "公开";
  const licenseText = m.license || "未声明";
  const breakable = (name) => esc(name).replace(/([/-])/g, "$1<wbr>");
  const tags = (m.tags || []).filter(
    (t) =>
      typeof t === "string" &&
      !t.startsWith("license:") &&
      !t.startsWith("base_model:") &&
      !t.startsWith("region:"),
  );
  const shownTags = tags.slice(0, 12);
  const extraTags = tags.slice(12);

  const item = (key, valueHtml, title = "", cls = "") =>
    `<div class="info-item ${cls}"><span class="k">${key}</span><span class="v"${
      title ? ` title="${esc(title)}"` : ""
    }>${valueHtml}</span></div>`;

  const dash = `<span style="color:var(--muted-2)">—</span>`;

  const shaHtml = m.sha
    ? `<button class="link-btn mono" data-copy="${esc(m.sha)}" title="点击复制完整提交 SHA">${esc(
        String(m.sha).slice(0, 10),
      )}</button>`
    : dash;

  return `
    <section class="repo-info">
      <div class="info-head">
        <h3>仓库信息</h3>
        <span class="muted" style="font-size:10.5px">元数据来自 Hugging Face</span>
      </div>
      <div class="info-grid">
        ${item("作者", esc(m.author || state.repo.split("/")[0] || "—"))}
        ${item("任务类型", m.pipeline ? `<span class="mono">${esc(m.pipeline)}</span>` : dash)}
        ${item("库", m.library ? `<span class="mono">${esc(m.library)}</span>` : dash)}
        ${item("许可证", esc(licenseText))}
        ${item(
          "基础模型",
          baseModelsHtml(m, breakable),
          (m.baseModels || []).join(", ") || m.baseModel || "",
          "wide",
        )}
        ${item("创建时间", `<span title="${esc(m.createdAt || "")}">${fmtDate(m.createdAt)}</span>`)}
        ${item(
          "最近更新",
          `<span title="${esc(m.lastModified || "")}">${fmtDate(m.lastModified)}</span>`,
        )}
        ${item("下载量（30 天）", `<b>${fmtNum(m.downloads)}</b>`, "Hugging Face 最近 30 天下的下载次数")}
        ${item(
          "存储占用",
          m.usedStorage ? fmtBytes(m.usedStorage) : dash,
          "该仓库在 Hugging Face 上占用的存储空间（包含历史版本）",
        )}
        ${item("提交", shaHtml)}
        ${item(
          "可见性",
          visibility === "公开"
            ? `<span style="color:var(--green)">公开</span>`
            : `<span style="color:#ffc861" title="需要在 HF_TOKEN 中配置有权限的令牌">${visibility}</span>`,
        )}
      </div>
      ${
        tags.length
          ? `<div class="info-tags">
               <span class="k">标签</span>
               ${shownTags.map((t) => `<span class="tag" title="${esc(t)}">${esc(t)}</span>`).join("")}
               ${extraTags
                 .map(
                   (t) =>
                     `<span class="tag extra" title="${esc(t)}">${esc(t)}</span>`,
                 )
                 .join("")}
               ${
                 extraTags.length
                   ? `<button class="link-btn" data-info-act="tags" data-extra="${extraTags.length}">+${extraTags.length}</button>`
                   : ""
               }
             </div>`
          : ""
      }
    </section>`;
}

function fileRowHtml(f) {
  const readme = README_RE.test(f.path);
  return `
    <tr data-path="${esc(f.path)}">
      <td class="check"><input type="checkbox" data-select="${esc(f.path)}" ${state.selected.has(f.path) ? "checked" : ""} /></td>
      <td>
        <div class="file-path">
          ${f.lfs ? `<span class="badge">LFS</span>` : ""}
          ${
            readme
              ? `<button class="file-link mono" data-act="readme" title="查看 README 内容">${esc(f.path)}</button>`
              : `<span class="name mono" title="${esc(f.path)}">${esc(f.path)}</span>`
          }
        </div>
      </td>
      <td class="num" title="${f.size} 字节">${fmtBytes(f.size)}</td>
      <td class="state" data-role="state">${fileStateHtml(f.path)}</td>
      <td class="act">
        <button class="btn sm" data-act="download" data-path="${esc(f.path)}">下载</button>
        <button class="btn ghost sm" data-act="copy-url" data-path="${esc(f.path)}" title="复制直链">直链</button>
      </td>
    </tr>`;
}

function fileStateHtml(path) {
  const task = state.tasks.get(taskKey(state.repo, path));
  const file = state.files.find((f) => f.path === path);
  if (task && ["queued", "running", "retrying", "paused"].includes(task.status)) {
    const pct = task.size ? Math.min(100, (task.downloaded / task.size) * 100) : 0;
    const label =
      task.status === "retrying"
        ? `${STATUS_LABEL.retrying} ${task.retryAttempt ?? 0}/${task.retryMax ?? 0}`
        : task.verifying && task.status === "running"
          ? STATUS_LABEL.verifying
          : STATUS_LABEL[task.status];
    return `
      <div class="mini">
        <div class="mini-row"><span>${label}</span><span>${pct.toFixed(1)}%</span></div>
        <div class="mini-bar"><i style="width:${pct}%"></i></div>
      </div>`;
  }
  if (task && task.status === "done") return `<span class="ok">✓ 已完成</span>`;
  if (task && task.status === "error") return `<span class="warn" title="${esc(task.error || "")}">下载出错</span>`;
  if (file?.local?.complete) return `<span class="ok">✓ 本地已有</span>`;
  if (file?.local?.size) {
    // 没有对应任务的残留半成品：给一个清理入口，否则「部分」状态永远消不掉
    const clean = file.local.rel
      ? `<button class="link-btn" data-act="clean-partial" data-rel="${esc(file.local.rel)}" title="删除未完成的本地文件">清理半成品</button>`
      : "";
    return `<span class="warn">部分 ${fmtBytes(file.local.size)}</span>${clean}`;
  }
  return `<span class="muted">—</span>`;
}

function syncFileStates() {
  const tbody = $("#file-tbody");
  if (!tbody) return;
  for (const tr of tbody.children) {
    const path = tr.dataset.path;
    const cell = tr.querySelector('[data-role="state"]');
    if (cell) cell.innerHTML = fileStateHtml(path);
  }
}

function applyFileFilter() {
  const f = state.fileFilter.trim().toLowerCase();
  const tbody = $("#file-tbody");
  if (!tbody) return;
  let visible = 0;
  for (const tr of tbody.children) {
    const hit = !f || tr.dataset.path.toLowerCase().includes(f);
    tr.style.display = hit ? "" : "none";
    if (hit) visible++;
  }
  const counter = $('[data-role="visible-count"]');
  if (counter)
    counter.textContent = f ? `${visible} / ${state.files.length} 个文件` : `${state.files.length} 个文件`;
}

function updateSelectionUI() {
  const info = $("#sel-info");
  const btn = $('[data-act="download-selected"]');
  const clearBtn = $('[data-act="clear-selection"]');
  if (!info || !btn) return;

  let bytes = 0;
  for (const path of state.selected) {
    const f = state.files.find((x) => x.path === path);
    if (f) bytes += f.size;
  }

  info.innerHTML = state.selected.size
    ? `已选 <b>${state.selected.size}</b> 个文件 · <b>${fmtBytes(bytes)}</b>`
    : "未选择文件";
  btn.disabled = state.selected.size === 0;
  if (clearBtn) clearBtn.disabled = state.selected.size === 0;

  for (const id of ["#sel-all", "#sel-all-2"]) {
    const box = $(id);
    if (!box) continue;
    box.checked = state.selected.size > 0 && state.selected.size === state.files.length;
    box.indeterminate = state.selected.size > 0 && state.selected.size < state.files.length;
  }

  $$("[data-select]").forEach((box) => {
    box.checked = state.selected.has(box.dataset.select);
  });
}

/* ------------------------------ 详情交互 ------------------------------ */

els.detail.addEventListener("click", async (e) => {
  const t = e.target;
  if (t.matches('a[target="_blank"]')) return;

  const copyEl = t.closest("[data-copy]");
  if (copyEl) {
    await copyText(copyEl.dataset.copy);
    return;
  }

  const baseModel = t.closest("[data-base-model]")?.dataset.baseModel;
  if (baseModel) {
    if (e.shiftKey) {
      await copyText(baseModel);
      return;
    }
    openBaseModel(baseModel);
    return;
  }

  const infoAct = t.closest("[data-info-act]")?.dataset.infoAct;
  if (infoAct === "tags") {
    const wrap = t.closest(".info-tags");
    if (wrap) {
      wrap.classList.toggle("expanded");
      const expanded = wrap.classList.contains("expanded");
      t.textContent = expanded ? "收起" : `+${t.dataset.extra}`;
    }
    return;
  }

  const act = t.closest("[data-act]")?.dataset.act;
  if (!act) return;

  if (act === "download-all") {
    if (!state.files.length) return;
    await queueDownloads(state.files.map((f) => f.path));
    return;
  }

  if (act === "download-selected") {
    await queueDownloads([...state.selected]);
    return;
  }

  if (act === "clear-selection") {
    state.selected.clear();
    updateSelectionUI();
    return;
  }

  if (act === "copy-repo") {
    copyText(state.repo);
    return;
  }

  if (act === "readme") {
    await openReadme(state.repo);
    return;
  }

  const path = t.closest("[data-path]")?.dataset.path;

  if (act === "download" && path) {
    await queueDownloads([path]);
    return;
  }

  if (act === "copy-url" && path) {
    const file = state.files.find((f) => f.path === path);
    if (file) copyText(file.downloadUrl);
    return;
  }

  if (act === "clean-partial") {
    const rel = t.closest("[data-rel]")?.dataset.rel;
    if (!rel) return;
    if (!confirm(`删除未下载完的本地文件？\n${rel}\n此操作不可恢复。`)) return;
    try {
      await api(`/api/local?path=${encodeURIComponent(rel)}`, { method: "DELETE" });
      toast("已清理半成品文件");
    } catch (err) {
      toast(err.message, 4000);
      return;
    }
    await reloadCurrentFiles();
    if (state.localLoaded) loadLocal();
  }
});

els.detail.addEventListener("change", (e) => {
  const t = e.target;

  if (t.id === "sel-all" || t.id === "sel-all-2") {
    if (t.checked) state.files.forEach((f) => state.selected.add(f.path));
    else state.selected.clear();
    updateSelectionUI();
    return;
  }

  if (t.dataset.select) {
    if (t.checked) state.selected.add(t.dataset.select);
    else state.selected.delete(t.dataset.select);
    updateSelectionUI();
  }
});

els.detail.addEventListener("input", (e) => {
  if (e.target.id === "file-filter") {
    state.fileFilter = e.target.value;
    applyFileFilter();
  }
});

async function queueDownloads(paths) {
  if (!state.repo || !paths.length) return;
  const files = paths.map((p) => state.files.find((f) => f.path === p)).filter(Boolean);

  const pending = files.filter((f) => {
    const t = state.tasks.get(taskKey(state.repo, f.path));
    return !(t && ["queued", "running"].includes(t.status));
  });

  if (!pending.length) {
    toast("选中的文件已在下载队列中");
    return;
  }

  toast(`已加入下载队列：${pending.length} 个文件`);
  state.tab = "tasks";
  renderRail();
  setRail(true);

  for (const f of pending) {
    try {
      await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ repo: state.repo, file: f.path, size: f.size }),
      });
    } catch (err) {
      toast(`加入队列失败：${err.message}`, 4000);
    }
  }
}

/* ------------------------------ 右栏：任务 ------------------------------ */

function setTasks(tasks, { silent = false } = {}) {
  const prev = state.tasks;
  const next = new Map();
  for (const t of tasks) next.set(taskKey(t.repo, t.file), t);

  const newlyDone = [];
  if (!silent) {
    for (const [k, t] of next) {
      const old = prev.get(k);
      if (t.status === "done" && (!old || old.status !== "done")) newlyDone.push(t);
    }
  }

  state.tasks = next;
  renderRail();
  syncFileStates();
  updateTaskBadge();

  if (newlyDone.length) {
    if (state.tab === "local" && state.localLoaded) loadLocal(true);
    if (state.repo) reloadCurrentFilesThrottled();
  }
}

let reloadTimer;
function reloadCurrentFilesThrottled() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadCurrentFiles();
    if (state.localLoaded) loadLocal();
  }, 900);
}

function sortedTasks() {
  const rank = { running: 0, retrying: 1, queued: 2, paused: 3, error: 4, canceled: 5, done: 6 };
  return [...state.tasks.values()].sort((a, b) => {
    const d = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    return d !== 0 ? d : b.createdAt - a.createdAt;
  });
}

function updateTaskBadge() {
  els.taskBadge.textContent = String(state.tasks.size);
  els.taskBadge.classList.toggle("zero", state.tasks.size === 0);
  if (els.railBadge) {
    els.railBadge.textContent = String(state.tasks.size);
    els.railBadge.classList.toggle("zero", state.tasks.size === 0);
  }
}

function taskCardHtml(t) {
  const pct = t.size ? Math.min(100, (t.downloaded / t.size) * 100) : 0;
  const label =
    t.status === "retrying"
      ? `${STATUS_LABEL.retrying} ${t.retryAttempt ?? 0}/${t.retryMax ?? 0}`
      : t.verifying && t.status === "running"
        ? STATUS_LABEL.verifying
        : STATUS_LABEL[t.status] || t.status;

  const actions =
    t.status === "running" || t.status === "queued" || t.status === "retrying"
      ? `<button class="btn ghost sm" data-tid="${t.id}" data-task-act="pause">暂停</button>
         <button class="btn ghost sm danger" data-tid="${t.id}" data-task-act="cancel">取消</button>`
      : t.status === "paused"
        ? `<button class="btn ghost sm" data-tid="${t.id}" data-task-act="resume" title="接着已下载部分继续">继续</button>
           <button class="btn ghost sm danger" data-tid="${t.id}" data-task-act="cancel">取消</button>`
        : t.status === "error" || t.status === "canceled"
          ? `<button class="btn ghost sm" data-tid="${t.id}" data-task-act="retry" data-repo="${esc(t.repo)}" data-file="${esc(t.file)}">重试</button>
             <button class="btn ghost sm" data-tid="${t.id}" data-task-act="remove">移除</button>
             <button class="btn ghost sm danger" data-tid="${t.id}" data-task-act="remove-file" title="移除任务并删除已下载的部分文件">删文件</button>`
          : `<button class="btn ghost sm" data-tid="${t.id}" data-task-act="reveal" data-dest="${esc(t.dest)}">路径</button>
             <button class="btn ghost sm danger" data-tid="${t.id}" data-task-act="remove-file">删除文件</button>`;

  return `
    <div class="rtask" data-id="${t.id}">
      <div class="rtask-top">
        <span class="rt-file mono" title="${esc(t.dest)}">${esc(t.file)}</span>
        ${engineTag(t)}
        <span class="status-pill ${t.status}" data-role="pill" title="${esc(t.error || label)}">${label}</span>
      </div>
      <div class="rt-repo" title="${esc(t.repo)}">${esc(t.repo)}</div>
      <div class="mini-bar"><i data-role="bar" style="width:${pct}%"></i></div>
      <div class="rt-meta">
        <span data-role="bytes">${fmtBytes(t.downloaded)}${t.size ? ` / ${fmtBytes(t.size)}` : ""}</span>
        <span data-role="pct">${pct.toFixed(1)}%</span>
      </div>
      <div class="rt-meta">
        <span data-role="speed" title="Xet 显示的是近 60 秒平均落盘速度（落盘是跳变的，瞬时值无意义）；开头几十秒是 Xet 在攒缓冲，磁盘上还没有字节">${speedLabel(t)}</span>
        <span class="eta${t.status === "error" || (t.status === "retrying" && t.error) ? " err" : ""}" data-role="eta">${
          t.status === "running" && t.eta
            ? `剩余 ${fmtEta(t.eta)}`
            : t.status === "retrying"
              ? esc(t.error ? `${t.error}，即将自动重试` : "网络错误，即将自动重试")
              : t.status === "error"
                ? esc(t.error || "出错")
                : ""
        }</span>
      </div>
      <div class="rt-actions">${actions}</div>
    </div>`;
}

/** 下载引擎标记：Xet（Rust 多连接）/ 直连（Node fetch 单连接）；两者都能续传 */
function engineTag(t) {
  if (t.engine !== "xet" && t.engine !== "fetch") return "";
  const xet = t.engine === "xet";
  return `<span class="engine-tag${xet ? " xet" : ""}" data-role="engine" title="${
    xet
      ? "Xet 多连接下载（Rust hf-xet）。支持断点续传：暂停 / 中断后接着已下载部分继续，完成后做整体 sha256 校验"
      : "Node 直连下载（单连接）。已下载部分会保留，重试 / 继续时接着下"
  }">${xet ? "Xet" : "直连"}</span>`;
}

function updateTaskCard(card, t) {
  const pct = t.size ? Math.min(100, (t.downloaded / t.size) * 100) : 0;
  const bar = card.querySelector('[data-role="bar"]');
  if (bar) bar.style.width = `${pct}%`;
  const bytes = card.querySelector('[data-role="bytes"]');
  if (bytes) bytes.textContent = `${fmtBytes(t.downloaded)}${t.size ? ` / ${fmtBytes(t.size)}` : ""}`;
  const pctEl = card.querySelector('[data-role="pct"]');
  if (pctEl) pctEl.textContent = `${pct.toFixed(1)}%`;
  const speed = card.querySelector('[data-role="speed"]');
  if (speed) speed.textContent = speedLabel(t);
  const engine = card.querySelector('[data-role="engine"]');
  if (engine && (t.engine === "xet" || t.engine === "fetch")) {
    engine.className = `engine-tag${t.engine === "xet" ? " xet" : ""}`;
    engine.textContent = t.engine === "xet" ? "Xet" : "直连";
  }
  const eta = card.querySelector('[data-role="eta"]');
  if (eta) {
    eta.classList.toggle("err", t.status === "error" || (t.status === "retrying" && !!t.error));
    eta.textContent =
      t.status === "running" && t.eta
        ? `剩余 ${fmtEta(t.eta)}`
        : t.status === "retrying"
          ? t.error
            ? `${t.error}，即将自动重试`
            : "网络错误，即将自动重试"
          : t.status === "error"
            ? t.error || "出错"
            : "";
  }
  const pill = card.querySelector('[data-role="pill"]');
  if (pill) {
    pill.textContent =
      t.status === "retrying"
        ? `${STATUS_LABEL.retrying} ${t.retryAttempt ?? 0}/${t.retryMax ?? 0}`
        : STATUS_LABEL[t.status] || t.status;
  }
}

let taskListSignature = "";

function renderTaskCards(force = false) {
  const tasks = sortedTasks();
  const signature = tasks.map((t) => `${t.id}:${t.status}`).join("|");

  if (!tasks.length) {
    els.railBody.innerHTML = `
      <div class="rail-empty">
        <span class="big-icon">⇩</span>
        还没有下载任务<br />在中间选择模型后点击「下载」
      </div>`;
    taskListSignature = "";
    return;
  }

  if (force || signature !== taskListSignature) {
    els.railBody.innerHTML = tasks.map(taskCardHtml).join("");
    taskListSignature = signature;
    return;
  }

  for (const t of tasks) {
    const card = els.railBody.querySelector(`.rtask[data-id="${t.id}"]`);
    if (card) updateTaskCard(card, t);
  }
}

/* ------------------------------ 右栏：已下载文件 ------------------------------ */

async function loadLocal(force = false) {
  if (state.localLoading) return;
  if (state.localLoaded && !force) return;

  state.localLoading = true;
  if (state.tab === "local" && (!state.localLoaded || force)) {
    els.railBody.dataset.local = "";
  }
  try {
    const data = await api("/api/local");
    state.local = data;
    state.localLoaded = true;
    if (state.config && data.dir) state.config.downloadDir = data.dir;
  } catch (err) {
    state.localLoaded = false;
    toast(`扫描本地文件失败：${err.message}`, 4000);
  } finally {
    state.localLoading = false;
    if (state.tab === "local") renderRail(true);
  }
}

function localCardsHtml() {
  if (state.localLoading) {
    return `<div class="rail-empty"><span class="spinner"></span> 正在扫描下载目录…</div>`;
  }
  if (!state.local.groups.length) {
    return `<div class="rail-empty">
        <span class="big-icon">▤</span>
        下载目录里还没有文件<br />
        <span class="mono" style="font-size:10.5px">${esc(state.config?.downloadDir || "")}</span>
      </div>`;
  }

  return state.local.groups
    .map((g) => {
      const rootPath = esc(state.config?.downloadDir || "");
      const prefix = g.dir ? `${g.dir}/` : "";
      const shown = g.files.slice(0, 60);
      const more = g.files.length - shown.length;
      return `
        <div class="lgroup">
          <div class="lg-head">
            <div class="lg-title mono" title="${esc(g.repo || g.dir || "根目录")}">
              ${esc(g.repo || g.dir || "（根目录）")}${g.isLoose ? `<span class="muted"> 散落文件</span>` : ""}
            </div>
            <div class="lg-sub">
              <span>${g.count} 个文件 · ${fmtBytes(g.size)}</span>
              <span class="spacer"></span>
              ${g.repo ? `<button class="link-btn" data-local-open="${esc(g.repo)}">查看模型</button>` : ""}
              ${
                g.isLoose
                  ? ""
                  : `<button class="icon-btn" data-local-group="${esc(g.dir)}" title="删除整组（该仓库目录下的全部文件）">✕</button>`
              }
            </div>
          </div>
          <div class="lg-files">
            ${shown
              .map(
                (f) => `
              <div class="lfile">
                <span class="lname mono" title="${esc(f.path)}">${esc(f.path.slice(prefix.length))}</span>
                <span class="lsize">${fmtBytes(f.size)}</span>
                <button class="icon-btn copy" data-local-copy="${esc(rootPath)}/${esc(f.path)}" title="复制完整路径">⧉</button>
                <button class="icon-btn" data-local-del="${esc(f.path)}" title="删除文件">✕</button>
              </div>`,
              )
              .join("")}
            ${more > 0 ? `<div class="lfile"><span class="lname muted">还有 ${more} 个文件…</span></div>` : ""}
          </div>
        </div>`;
    })
    .join("");
}

/* ------------------------------ 右栏渲染 & 事件 ------------------------------ */

let lastTab = "";

function setFoot(html) {
  if (els.railFoot.dataset.html === html) return;
  els.railFoot.dataset.html = html;
  els.railFoot.innerHTML = html;
}

function renderRail(force = false) {
  $$(".rail-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === state.tab));
  updateTaskBadge();

  const tasks = sortedTasks();
  const running = tasks.filter((t) => t.status === "running");
  const queued = tasks.filter((t) => t.status === "queued");
  const speed = running.reduce((a, t) => a + (t.speed || 0), 0);

  if (state.tab === "tasks") {
    if (lastTab !== "tasks") force = true;
    const retrying = tasks.filter((t) => t.status === "retrying");
    const paused = tasks.filter((t) => t.status === "paused");
    setFoot(`
      <span class="muted" style="font-size:11px">${tasks.length} 个任务${
        running.length ? ` · ${running.length} 个下载中` : ""
      }${queued.length ? ` · ${queued.length} 个排队` : ""}${
        retrying.length ? ` · ${retrying.length} 个重试中` : ""
      }${
        paused.length ? ` · ${paused.length} 个已暂停` : ""
      }${speed > 0 ? ` · ${fmtSpeed(speed)}` : ""}</span>
      <span class="spacer"></span>
      ${paused.length ? `<button class="btn ghost sm" id="resume-all">全部继续</button>` : ""}
      ${
        running.length + queued.length + retrying.length
          ? `<button class="btn ghost sm" id="pause-all">全部暂停</button>`
          : ""
      }
      <button class="btn ghost sm danger" id="cancel-all" ${tasks.length ? "" : "disabled"}>全部取消</button>`);
    renderTaskCards(force);
  } else {
    if (state.localLoading && !state.localLoaded) {
      els.railBody.innerHTML = `<div class="rail-empty"><span class="spinner"></span> 正在扫描下载目录…</div>`;
      els.railBody.dataset.local = "";
      setFoot(`<span class="muted" style="font-size:11px">扫描中…</span>`);
    } else {
      if (force || state.localLoading || els.railBody.dataset.local !== "1") {
        els.railBody.innerHTML = localCardsHtml();
        els.railBody.dataset.local = "1";
      }
      setFoot(`
        <span class="muted" style="font-size:11px">共 ${state.local.count || 0} 个文件 · ${fmtBytes(state.local.totalSize)}</span>
        <span class="spacer"></span>
        <button class="btn ghost sm" id="local-refresh">刷新</button>`);
    }
  }

  lastTab = state.tab;
}

$$(".rail-tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    if (state.tab === tab.dataset.tab) return;
    state.tab = tab.dataset.tab;
    if (state.tab === "local" && !state.localLoaded) loadLocal();
    lastTab = "";
    renderRail(true);
  }),
);

const RAIL_KEY = "hf.railOpen";

function setRail(open, { persist = true } = {}) {
  els.rail.classList.toggle("closed", !open);
  els.layout.classList.toggle("rail-closed", !open);
  els.railToggle.title = open ? "收起右栏" : "展开下载面板";
  if (els.railLauncher) els.railLauncher.hidden = open;
  if (persist) localStorage.setItem(RAIL_KEY, open ? "1" : "0");
}

els.railToggle.addEventListener("click", () => {
  setRail(els.rail.classList.contains("closed"));
});

els.railLauncher.addEventListener("click", () => {
  setRail(true);
  els.railBody.scrollTop = 0;
});

els.railFoot.addEventListener("click", async (e) => {
  if (e.target.id === "cancel-all") {
    try {
      await api("/api/tasks/cancel-all", { method: "POST" });
      toast("已取消所有进行中的任务");
    } catch (err) {
      toast(err.message, 4000);
    }
    return;
  }
  if (e.target.id === "pause-all") {
    try {
      await api("/api/tasks/pause-all", { method: "POST" });
      toast("已暂停所有任务，进度已保留");
    } catch (err) {
      toast(err.message, 4000);
    }
    return;
  }
  if (e.target.id === "resume-all") {
    try {
      await api("/api/tasks/resume-all", { method: "POST" });
      toast("已继续所有暂停的任务");
    } catch (err) {
      toast(err.message, 4000);
    }
    return;
  }
  if (e.target.id === "local-refresh") {
    loadLocal(true);
  }
});

/** 下载根目录（去掉尾斜杠），用于把相对路径拼成绝对路径比对 */
function rootDir() {
  return String(state.config?.downloadDir || "").replace(/\/+$/, "");
}

els.railBody.addEventListener("click", async (e) => {
  const target = e.target.closest("[data-task-act], [data-local-del], [data-local-group], [data-local-copy], [data-local-open]");
  if (!target) return;

  const taskAct = target.dataset.taskAct;
  if (taskAct) {
    const id = target.dataset.tid;
    try {
      if (taskAct === "cancel") {
        await api(`/api/tasks/${id}/cancel`, { method: "POST" });
      } else if (taskAct === "pause") {
        await api(`/api/tasks/${id}/pause`, { method: "POST" });
      } else if (taskAct === "resume") {
        await api(`/api/tasks/${id}/resume`, { method: "POST" });
      } else if (taskAct === "retry") {
        // 重试会接着已下载部分继续（两个引擎都支持续传），不会作废进度
        await api("/api/tasks", {
          method: "POST",
          body: JSON.stringify({ repo: target.dataset.repo, file: target.dataset.file }),
        });
      } else if (taskAct === "remove") {
        // 只移除任务记录，已下载部分留在磁盘上，下次下载同一文件会接着下
        await api(`/api/tasks/${id}`, { method: "DELETE" });
      } else if (taskAct === "remove-file") {
        if (!confirm("同时删除已下载到磁盘的文件（含未下完的半成品）？此操作不可恢复。")) return;
        await api(`/api/tasks/${id}?deleteFile=1`, { method: "DELETE" });
        toast("任务与本地文件已删除");
        if (state.localLoaded) loadLocal();
        if (state.repo) reloadCurrentFilesThrottled();
      } else if (taskAct === "reveal") {
        await copyText(target.dataset.dest);
      }
    } catch (err) {
      toast(err.message, 4000);
    }
    return;
  }

  if (target.dataset.localCopy) {
    await copyText(target.dataset.localCopy);
    return;
  }

  if (target.dataset.localOpen) {
    selectModel(target.dataset.localOpen);
    return;
  }

  // 删除文件 / 删除整组
  const rel = target.dataset.localDel ?? target.dataset.localGroup;
  if (rel === undefined) return;
  const isGroup = target.dataset.localGroup !== undefined;
  const name = isGroup ? rel || "根目录" : rel;

  // 正在下载的文件（含可续传的半成品 .xet-partial）被删掉时，服务端会顺手把对应任务一并抹掉
  const hitting = [...state.tasks.values()].filter((t) => {
    const relFromDir = isGroup ? `${rel}/` : rel;
    return t.dest === `${rootDir()}/${relFromDir}`.replace(/\/+$/, "") || t.dest.startsWith(`${rootDir()}/${relFromDir}`);
  });
  const active = hitting.filter((t) => ["running", "queued", "retrying", "paused"].includes(t.status));
  const activeNote = active.length
    ? `\n\n注意：其中 ${active.length} 个是正在下载/暂停的任务，删除会中断它们并把已下载的部分一起删掉（之后要重头下）。`
    : "";
  if (!confirm(`确定删除${isGroup ? "整个目录" : "文件"}？\n${name}\n\n删除后不可恢复。${activeNote}`)) return;

  try {
    await api(`/api/local?path=${encodeURIComponent(rel)}`, { method: "DELETE" });
    toast("已删除");
    loadLocal(true);
    if (state.repo) reloadCurrentFilesThrottled();
  } catch (err) {
    toast(err.message, 4000);
  }
});

/* ------------------------------ README / 模型卡片 ------------------------------ */

marked.setOptions({ gfm: true, breaks: false });

const readmeCache = new Map();
let readmeSeq = 0;

function stripFrontMatter(md) {
  return String(md).replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function resolveReadmeUrl(url, base) {
  try {
    return new URL(url.replace(/^\.\//, ""), base).href;
  } catch {
    return url;
  }
}

function renderReadmeHtml(md, repo) {
  const endpoint = state.config?.endpoint || "https://hf-mirror.com";
  const encodedRepo = repo.split("/").map(encodeURIComponent).join("/");
  const assetBase = `${endpoint}/${encodedRepo}/resolve/main/`;
  const linkBase = `${endpoint}/${repo}/blob/main/`;

  const raw = marked.parse(stripFrontMatter(md));
  const clean = DOMPurify.sanitize(raw, { ADD_ATTR: ["target", "align"] });
  const doc = new DOMParser().parseFromString(clean, "text/html");

  doc.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src");
    if (src && !/^(https?:)?\/\//i.test(src) && !src.startsWith("data:")) {
      img.setAttribute("src", resolveReadmeUrl(src, assetBase));
    }
    img.setAttribute("loading", "lazy");
    img.setAttribute("referrerpolicy", "no-referrer");
  });

  doc.querySelectorAll("a").forEach((a) => {
    const href = a.getAttribute("href");
    if (!href) return;
    if (/^(https?:)?\/\//i.test(href) || href.startsWith("#") || /^(mailto|tel):/i.test(href)) {
      return;
    }
    a.setAttribute("href", resolveReadmeUrl(href, linkBase));
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noreferrer");
  });

  return doc.body.innerHTML;
}

async function openReadme(repo) {
  if (!repo) return;
  const modal = $("#readme-modal");
  const body = $("#readme-body");
  const external = $("#readme-external");
  const endpoint = state.config?.endpoint || "https://hf-mirror.com";

  $("#readme-repo").textContent = repo;
  external.href = `${endpoint}/${repo}`;
  modal.classList.remove("hidden");
  body.scrollTop = 0;
  body.innerHTML = `<div class="readme-loading"><span class="spinner"></span> 正在读取 README…</div>`;

  const seq = ++readmeSeq;
  try {
    let data = readmeCache.get(repo);
    if (!data) {
      const res = await api(`/api/readme?repo=${encodeURIComponent(repo)}`);
      data = res.readme;
      readmeCache.set(repo, data);
    }
    if (seq !== readmeSeq) return;

    if (!data?.content) {
      body.innerHTML = `
        <div class="readme-empty">
          <div class="big-icon">▤</div>
          这个仓库没有 README 文件
          ${data?.error ? `<p class="muted" style="font-size:11.5px">${esc(data.error)}</p>` : ""}
        </div>`;
      return;
    }

    if (data.url) external.href = data.url;
    body.innerHTML = renderReadmeHtml(data.content, repo);
    bindReadmeImages(body);
  } catch (err) {
    if (seq !== readmeSeq) return;
    body.innerHTML = `<div class="readme-empty">读取 README 失败：${esc(err.message)}</div>`;
  }
}

function bindReadmeImages(root) {
  const markFailed = (img) => {
    if (!img.isConnected || img.dataset.failed) return;
    img.dataset.failed = "1";
    const name = (() => {
      try {
        return decodeURIComponent(new URL(img.src).pathname.split("/").pop() || "");
      } catch {
        return "";
      }
    })();
    const note = document.createElement("span");
    note.className = "img-error";
    note.textContent = `图片加载失败${name ? `：${name}` : ""}（门控 / 私有仓库需配置 HF_TOKEN）`;
    img.replaceWith(note);
  };

  for (const img of root.querySelectorAll("img")) {
    img.addEventListener("error", () => markFailed(img), { once: true });
    if (img.complete && img.naturalWidth === 0) markFailed(img);
  }
}

function closeReadme() {
  readmeSeq++;
  $("#readme-modal").classList.add("hidden");
}

$("#readme-close").addEventListener("click", closeReadme);
$("#readme-modal").addEventListener("click", (e) => {
  if (e.target.id === "readme-modal") closeReadme();
});

/* ------------------------------ 下载目录设置 ------------------------------ */

async function saveDir(value = els.dirInput.value.trim(), { silent = false } = {}) {
  if (!value) {
    toast("请输入下载目录");
    return false;
  }
  const btn = $("#dir-save");
  btn.disabled = true;
  try {
    state.config = await api("/api/config", {
      method: "POST",
      body: JSON.stringify({ downloadDir: value }),
    });
    els.dirInput.value = state.config.downloadDir;
    renderMeta();
    updateDirUI();
    if (!silent) toast(`下载目录已切换到 ${state.config.downloadDir}`, 3200);
    if (state.localLoaded) loadLocal(true);
    if (state.repo) reloadCurrentFiles();
    return true;
  } catch (err) {
    toast(err.message, 5000);
    return false;
  } finally {
    btn.disabled = false;
  }
}

$("#dir-save").addEventListener("click", () => saveDir());
els.dirInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveDir();
  }
});

$("#copy-dir").addEventListener("click", () => {
  if (state.config?.downloadDir) copyText(state.config.downloadDir);
});

/* ------------------------------ Xet 调优设置 ------------------------------ */

async function saveXetSettings(payload, okMessage) {
  const btn = $("#xet-save");
  btn.disabled = true;
  try {
    state.config = await api("/api/config", { method: "POST", body: JSON.stringify(payload) });
    updateXetUI();
    toast(okMessage, 3600);
    return true;
  } catch (err) {
    toast(err.message, 5000);
    updateXetUI(); // 回滚控件到服务端真实值
    return false;
  } finally {
    btn.disabled = false;
  }
}

$("#xet-hp").addEventListener("change", (e) => {
  saveXetSettings(
    { xetHighPerformance: e.target.checked },
    e.target.checked
      ? "已开启 Xet 高性能模式（并发 124），仅对新任务生效"
      : "已关闭 Xet 高性能模式（并发 64），仅对新任务生效",
  );
});

$("#xet-budget").addEventListener("change", (e) => {
  const mb = Math.round(Number(e.target.value));
  if (!Number.isFinite(mb) || mb < 128 || mb > 32768) {
    toast("内存预算需在 128 ~ 32768 MB 之间", 4000);
    updateXetUI();
    return;
  }
  saveXetSettings({ xetMemoryBudgetMb: mb }, `Xet 内存预算已设为 ${mb} MB，仅对新任务生效`);
});

/* ------------------------------ 访问令牌设置 ------------------------------ */

const TOKEN_SOURCE_LABEL = {
  settings: "界面设置",
  env: "环境变量 HF_TOKEN",
  cleared: "曾在界面清除",
  none: "未配置",
};

function bindTokenModal() {
  els.meta.addEventListener("click", (e) => {
    if (e.target.closest("#token-chip")) openTokenModal();
  });
  $("#token-modal-close").addEventListener("click", closeTokenModal);
  $("#token-cancel").addEventListener("click", closeTokenModal);
  $("#token-modal").addEventListener("click", (e) => {
    if (e.target.id === "token-modal") closeTokenModal();
  });
  $("#token-show").addEventListener("change", (e) => {
    $("#token-input").type = e.target.checked ? "text" : "password";
  });
  $("#token-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitToken();
    }
  });
  $("#token-save").addEventListener("click", submitToken);
  $("#token-clear").addEventListener("click", () => {
    if (!state.config?.hasToken) {
      toast("当前没有配置令牌");
      return;
    }
    saveToken("", "已清除访问令牌，之后只能下载公开仓库");
  });
}

function submitToken() {
  const value = $("#token-input").value.trim();
  if (!value) {
    toast("要清除令牌请点「清除令牌」");
    return;
  }
  saveToken(value, "访问令牌已保存并通过校验");
}

function openTokenModal() {
  const input = $("#token-input");
  input.type = "password";
  input.value = "";
  input.placeholder = state.config?.hasToken ? "输入新令牌以替换" : "hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  $("#token-show").checked = false;
  $("#token-link").href = `${state.config?.endpoint || "https://hf-mirror.com"}/settings/tokens`;
  renderTokenMeta({ ...(state.config?.token || {}), hasToken: state.config?.hasToken });
  $("#token-modal").classList.remove("hidden");
  input.focus();
  api("/api/token")
    .then(renderTokenMeta)
    .catch((err) =>
      renderTokenMeta({
        ...(state.config?.token || {}),
        verified: null,
        error: `${err.message}（服务若是旧进程，重启后生效）`,
      }),
    );
}

function closeTokenModal() {
  $("#token-modal").classList.add("hidden");
}

function renderTokenMeta(t) {
  const box = $("#token-meta");
  if (!box) return;
  if (!t?.hasToken) {
    box.innerHTML =
      t?.source === "cleared"
        ? `<span class="bad">当前不使用令牌</span>（此前在界面上清除过，启动时的 HF_TOKEN 也会被忽略）`
        : `当前未配置令牌，只能下载公开仓库`;
    return;
  }
  const head = `已保存 <b class="mono">${esc(t.hint || "")}</b> · 来源：${esc(TOKEN_SOURCE_LABEL[t.source] || t.source || "—")}`;
  if (t.verified === true) {
    box.innerHTML = `${head}<br /><span class="good">✓ 镜像站校验通过${t.user ? ` · 账号 ${esc(t.user)}</span>` : "</span>"}`;
  } else if (t.verified === false) {
    box.innerHTML = `${head}<br /><span class="bad">✕ 镜像站认为该令牌无效（HTTP ${esc(t.status ?? "")}）</span>`;
  } else {
    box.innerHTML = `${head}${t.error ? `<br />未校验成功：${esc(t.error)}` : ""}`;
  }
}

async function saveToken(value, okMessage) {
  const btn = $("#token-save");
  const clr = $("#token-clear");
  btn.disabled = clr.disabled = true;
  try {
    const cfg = await api("/api/config", { method: "POST", body: JSON.stringify({ hfToken: value }) });
    if (!cfg || typeof cfg.token !== "object" || cfg.token === null) {
      // 旧版后端不认识 hfToken，会静默返回 200 —— 必须明确报错，不能假装保存成功
      toast("后端未包含令牌接口：请重启服务（重新 pnpm start）后再配置令牌", 6500);
      return false;
    }
    state.config = cfg;
    renderMeta();
    updateXetUI();
    toast(state.config.tokenWarning || okMessage, 4500);
    closeTokenModal();
    if (state.repo) {
      state.localLoaded = false;
      reloadCurrentFiles();
    }
    return true;
  } catch (err) {
    toast(err.message, 5500);
    api("/api/token")
      .then(renderTokenMeta)
      .catch(() => {});
    return false;
  } finally {
    btn.disabled = clr.disabled = false;
  }
}

/* ------------------------------ 目录选择器 ------------------------------ */

const picker = {
  open: false,
  path: "/",
  parent: null,
  dirs: [],
  disk: null,
  showHidden: false,
  roots: [],
  rootsLoaded: false,
  saving: false,
};

async function openDirPicker() {
  picker.open = true;
  els.dirModal.classList.remove("hidden");
  if (!picker.rootsLoaded) loadFsRoots();
  await fsGo(state.config?.downloadDir || "/");
}

function closeDirPicker() {
  picker.open = false;
  els.dirModal.classList.add("hidden");
}

async function loadFsRoots() {
  els.fsRoots.innerHTML = `<div class="fs-loading"><span class="spinner"></span> 读取磁盘…</div>`;
  try {
    const data = await api("/api/fs/roots");
    picker.roots = data.roots || [];
    picker.rootsLoaded = true;
    renderFsRoots();
  } catch (err) {
    els.fsRoots.innerHTML = `<div class="fs-empty">读取失败：${esc(err.message)}</div>`;
  }
}

function rootIcon(kind) {
  if (kind === "home") return "🏠";
  if (kind === "root") return "▣";
  if (kind === "disk") return "💽";
  return "📁";
}

function renderFsRoots() {
  if (!picker.roots.length) {
    els.fsRoots.innerHTML = `<div class="fs-empty">没有可用的磁盘</div>`;
    return;
  }
  els.fsRoots.innerHTML = picker.roots
    .map(
      (r) => `
      <button class="fs-root ${r.path === picker.path ? "active" : ""}" data-root="${esc(r.path)}" title="${esc(r.path)}">
        <span class="ic">${rootIcon(r.kind)}</span>
        <span class="meta">
          <span class="name">${esc(r.label)}</span>
          <span class="sub">${esc(r.path)}${r.disk ? ` · ${fmtBytes(r.disk.free)} 可用` : ""}</span>
        </span>
      </button>`,
    )
    .join("");
}

function renderFsCrumbs() {
  const parts = picker.path.split("/").filter(Boolean);
  let acc = "";
  const items = [`<button class="crumb" data-crumb="/">根目录</button>`];
  for (const part of parts) {
    acc += `/${part}`;
    items.push(`<span class="crumb-sep">›</span>`);
    items.push(`<button class="crumb" data-crumb="${esc(acc)}">${esc(part)}</button>`);
  }
  els.fsCrumbs.innerHTML = items.join("");
}

function renderFsList() {
  const dirs = picker.showHidden ? picker.dirs : picker.dirs.filter((d) => !d.name.startsWith("."));
  if (!dirs.length) {
    els.fsList.innerHTML = `<div class="fs-empty">这个目录下没有子文件夹</div>`;
    return;
  }
  els.fsList.innerHTML = dirs
    .map(
      (d) => `
      <button class="fs-item" data-dir="${esc(d.path)}" title="${esc(d.path)}">
        <span class="ic">📁</span>
        <span class="nm">${esc(d.name)}${d.symlink ? ` <span class="hint">符号链接</span>` : ""}</span>
        <span class="hint">进入 ›</span>
      </button>`,
    )
    .join("");
}

async function fsGo(target) {
  const p = String(target || "/").trim() || "/";
  try {
    const data = await api(`/api/fs/list?path=${encodeURIComponent(p)}`);
    picker.path = data.path;
    picker.parent = data.parent;
    picker.dirs = data.dirs || [];
    picker.disk = data.disk;
    els.fsPath.value = data.path;
    els.fsCurrent.textContent = data.path;
    els.fsDisk.textContent = data.disk
      ? `剩余 ${fmtBytes(data.disk.free)} / 共 ${fmtBytes(data.disk.total)}`
      : "";
    renderFsCrumbs();
    renderFsList();
    renderFsRoots();
  } catch (err) {
    toast(err.message, 4000);
  }
}

async function fsMkdir() {
  const name = prompt("新文件夹名称：");
  if (!name || !name.trim()) return;
  try {
    const created = await api("/api/fs/mkdir", {
      method: "POST",
      body: JSON.stringify({ path: picker.path, name: name.trim() }),
    });
    toast(`已创建：${created.name}`);
    await fsGo(created.path);
  } catch (err) {
    toast(err.message, 4000);
  }
}

$("#dir-pick").addEventListener("click", openDirPicker);
$("#dir-modal-close").addEventListener("click", closeDirPicker);
$("#dir-cancel").addEventListener("click", closeDirPicker);

els.dirModal.addEventListener("click", (e) => {
  if (e.target === els.dirModal) closeDirPicker();
});

els.fsRoots.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-root]");
  if (btn) fsGo(btn.dataset.root);
});

els.fsCrumbs.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-crumb]");
  if (btn) fsGo(btn.dataset.crumb);
});

els.fsList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-dir]");
  if (btn) fsGo(btn.dataset.dir);
});

$("#fs-up").addEventListener("click", () => {
  if (picker.parent) fsGo(picker.parent);
});

$("#fs-go").addEventListener("click", () => fsGo(els.fsPath.value));

els.fsPath.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    fsGo(els.fsPath.value);
  }
});

$("#fs-refresh").addEventListener("click", () => fsGo(picker.path));

els.fsShowHidden.addEventListener("change", () => {
  picker.showHidden = els.fsShowHidden.checked;
  renderFsList();
});

$("#fs-mkdir").addEventListener("click", fsMkdir);

$("#dir-choose").addEventListener("click", async () => {
  if (picker.saving) return;
  if (!picker.path) {
    toast("请先选择一个目录");
    return;
  }
  picker.saving = true;
  const ok = await saveDir(picker.path, { silent: true });
  picker.saving = false;
  if (ok) {
    toast(`下载目录已切换到 ${state.config.downloadDir}`, 3200);
    closeDirPicker();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (picker.open) {
    e.preventDefault();
    closeDirPicker();
    return;
  }
  if (!$("#token-modal").classList.contains("hidden")) {
    e.preventDefault();
    closeTokenModal();
    return;
  }
  if (!$("#readme-modal").classList.contains("hidden")) {
    e.preventDefault();
    closeReadme();
  }
});

init();
