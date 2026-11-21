// 单文件打包：把「Node 运行时 + 服务端 + vite 前端产物 + xet-dl 下载器」拼成一个裸可执行文件。
//
//   pnpm run package:sea                 # 自动按当前系统/架构出包
//   node scripts/build-sea.mjs --target=windows-x64
//
// 产物：release-build/hf-ui-<target>[.exe] 和同名 .sha256
// 前置：pnpm build（本脚本默认自己跑）+ cargo 出好的 native/bin/xet-dl[.exe]
//
// 原理：Node 自带的「Single Executable Application」——把一段 blob 追加到 node 二进制尾部，
// 运行时用 node:sea 读内嵌资源（见 server/sea.js、server/webroot.js）。服务端入口先用
// esbuild 打成单个 CJS 文件：SEA 的 main 只能是 CommonJS（顶层 await 也不支持）。
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = path.join(ROOT, "build");
const ASSETS = path.join(BUILD, "sea-assets");
const OUT = path.join(ROOT, "release-build");
const require = createRequire(import.meta.url);

const TARGETS = {
  "linux-x64": { platform: "linux", arch: "x64", rust: "x86_64-unknown-linux-gnu" },
  "linux-arm64": { platform: "linux", arch: "arm64", rust: "aarch64-unknown-linux-gnu" },
  "macos-x64": { platform: "darwin", arch: "x64", rust: "x86_64-apple-darwin" },
  "macos-arm64": { platform: "darwin", arch: "arm64", rust: "aarch64-apple-darwin" },
  "windows-x64": { platform: "win32", arch: "x64", rust: "x86_64-pc-windows-msvc" },
};

const args = process.argv.slice(2);
const skipVite = args.includes("--skip-web");
const targetFlag = args.find((a) => a.startsWith("--target="))?.slice("--target=".length);
const target = targetFlag || autoTarget();
const spec = TARGETS[target];
if (!spec) fail(`未知目标 ${target}，可选：${Object.keys(TARGETS).join(" / ")}`);

const EXE = spec.platform === "win32" ? ".exe" : "";
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const binaryName = `hf-ui-${target}${EXE}`;

log(`目标平台 ${target}（${spec.rust}）· Node ${process.versions.node}`);

// SEA 的底座就是「运行本脚本的这个 node」，不能跨平台交叉编译
if (process.platform !== spec.platform || process.arch !== spec.arch) {
  fail(
    `SEA 只能用当前 Node 出包：本机是 ${process.platform}-${process.arch}，` +
      `不能出 ${target}。请在对应平台的机器/CI 上构建。`,
  );
}

// ---- 1. 前端 ---------------------------------------------------------------
if (skipVite) {
  log("跳过 vite build（--skip-web）");
} else {
  const viteBin = path.join(path.dirname(require.resolve("vite/package.json")), "bin", "vite.js");
  log("vite build …");
  run(process.execPath, [viteBin, "build"]);
}
const distDir = path.join(ROOT, "dist");
const distIndex = path.join(distDir, "index.html");
if (!fs.existsSync(distIndex)) fail(`缺少前端产物 ${path.relative(ROOT, distIndex)}，先跑 pnpm build`);

// ---- 2. 下载器 -------------------------------------------------------------
const xetSrc = path.join(ROOT, "native", "bin", `xet-dl${EXE}`);
if (!fs.existsSync(xetSrc)) {
  fail(
    `缺少 ${path.relative(ROOT, xetSrc)}。先编译 Rust 下载器：\n` +
      `  cargo build --release --locked --manifest-path native/xet-dl/Cargo.toml --target ${spec.rust}\n` +
      `  然后把 target/${spec.rust}/release/xet-dl${EXE} 复制到 native/bin/`,
  );
}

// ---- 3. 打平服务端为单个 CJS -----------------------------------------------
fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(ASSETS, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

log("esbuild 打包服务端 …");
const { build } = await import("esbuild");
const serverCjs = path.join(BUILD, "server.cjs");
await build({
  entryPoints: [path.join(ROOT, "server", "index.js")],
  outfile: serverCjs,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: `node${process.versions.node.split(".")[0]}`,
  // SEA 里没有 node_modules，全部打进单文件（esbuild 会把 node: 内建模块留作外部）
  external: ["node:sea"],
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
}).then((result) => {
  const kb = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
  log(`  → ${path.relative(ROOT, serverCjs)}（${Math.round(kb / 1024)} KB）`);
});

// ---- 4. 组装内嵌资源 -------------------------------------------------------
const assets = {};
const put = (key, src) => {
  assets[key] = path.relative(ROOT, src).split(path.sep).join("/");
};

// 服务端入口不能用 .mjs：SEA 里 ESM 的模块类型判定依赖 package.json type，会直接报错
put("server.cjs", serverCjs);

let webFiles = 0;
let webBytes = 0;
for (const file of walk(distDir)) {
  const rel = path.relative(distDir, file).split(path.sep).join("/");
  const dest = path.join(ASSETS, "web", rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
  put(`web/${rel}`, dest);
  webFiles += 1;
  webBytes += fs.statSync(dest).size;
}

const xetDest = path.join(ASSETS, "bin", `xet-dl${EXE}`);
fs.mkdirSync(path.dirname(xetDest), { recursive: true });
fs.copyFileSync(xetSrc, xetDest);
put("bin/xet-dl", xetDest); // 服务端按固定 key 读取（server/sea.js extractXetBinary）

const meta = {
  name: pkg.name,
  version: pkg.version,
  target,
  rustTarget: spec.rust,
  node: process.versions.node,
  built: new Date().toISOString(),
  commit: tryGit("rev-parse", "--short", "HEAD") || "unknown",
  host: `${os.platform()}-${os.arch()}`,
};
const metaFile = path.join(BUILD, "meta.json");
fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
put("meta.json", metaFile);

// ---- 5. 生成单文件 ---------------------------------------------------------
const seaConfig = path.join(BUILD, "sea-config.json");
fs.writeFileSync(
  seaConfig,
  `${JSON.stringify(
    {
      main: path.relative(ROOT, serverCjs).split(path.sep).join("/"),
      output: path.relative(ROOT, path.join(OUT, binaryName)).split(path.sep).join("/"),
      disableExperimentalSEAWarning: true,
      assets,
    },
    null,
    2,
  )}\n`,
);
log(`node --build-sea（内嵌 ${webFiles} 个前端文件 / ${(webBytes / 1024 / 1024).toFixed(1)} MB + 下载器）…`);
run(process.execPath, [`--build-sea=${seaConfig}`]);

// Windows 上 Node 会自动补 .exe，这里把两种可能都收敛到唯一产物名
let produced = path.join(OUT, binaryName);
if (!fs.existsSync(produced) && EXE) {
  const guess = path.join(OUT, `hf-ui-${target}${EXE}${EXE}`);
  if (fs.existsSync(guess)) {
    fs.renameSync(guess, produced);
  }
}
if (!fs.existsSync(produced)) fail(`--build-sea 没有产出 ${path.relative(ROOT, produced)}`);
try {
  fs.chmodSync(produced, 0o755);
} catch {
  /* Windows 无 chmod */
}

// macOS：改过二进制的签名会失效，ad-hoc 重签一次，否则 Gatekeeper 直接判「已损坏」
if (spec.platform === "darwin") {
  try {
    run("codesign", ["--force", "--sign", "-", produced]);
    log("  → 已 ad-hoc 重签名（macOS）");
  } catch (err) {
    log(`  ⚠️ codesign 失败（${err.message}），首次运行可能被 Gatekeeper 拦下`);
  }
}

const bytes = fs.statSync(produced).size;
const sha = crypto.createHash("sha256").update(fs.readFileSync(produced)).digest("hex");
const shaFile = `${produced}.sha256`;
fs.writeFileSync(shaFile, `${sha}  ${binaryName}\n`);

log(`完成 ${path.relative(ROOT, produced)}  ${(bytes / 1024 / 1024).toFixed(1)} MB`);
log(`  sha256 ${sha}`);
console.log(`\n运行：PORT=2270 ${process.platform === "win32" ? "" : "./"}${binaryName}`);

// ---- 工具 -----------------------------------------------------------------
function autoTarget() {
  const osName = { linux: "linux", darwin: "macos", win32: "windows" }[process.platform] ?? process.platform;
  const key = `${osName}-${process.arch}`;
  if (!TARGETS[key]) fail(`当前 ${process.platform}-${process.arch} 不在支持列表，用 --target= 指定`);
  return key;
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

function run(cmd, cmdArgs) {
  execFileSync(cmd, cmdArgs, { cwd: ROOT, stdio: "inherit" });
}

function tryGit(...gitArgs) {
  try {
    return execFileSync("git", gitArgs, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function log(msg) {
  console.log(`[build-sea] ${msg}`);
}

function fail(msg) {
  console.error(`[build-sea] ${msg}`);
  process.exit(1);
}
