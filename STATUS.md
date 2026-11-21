# STATUS

滚动收尾状态文档：最新条目在最上方。历史全文见本文件（本仓已入 git，历史全文同时由 git 历史承载）。

---

## 2026-11-21（第 6 轮）服务器编译成单个可执行文件（内嵌 Web）+ 三平台 Release 工作流

### 本次完成
1. **单文件可执行（Node SEA）方案落地**：一个可执行文件里同时装了 Node 运行时、Express 服务端、
   vite 构建好的 Web 界面、以及 Rust 写的 Xet 下载器，用 Node 26 的 SEA 内嵌资源（`assets`）实现，
   不需要任何外部目录，也不需要目标机器装 Node。
   - `scripts/build-sea.mjs`（新增）：`vite build` → `esbuild` 把 `server/index.js` 打成单文件 CJS
     （`bundle/platform:node/format:cjs/target:node26/external:["node:sea"]`，1 281 KB）→ 组装内嵌资源
     `build/sea-assets/{web/**,bin/xet-dl}` + `build/meta.json` → 生成 `build/sea-config.json` →
     `node --build-sea` → 产物 `release-build/hf-ui-<target>[.exe]` 与同名 `.sha256`；macOS 自动
     `codesign --force --sign -`（ad-hoc）。支持 `--target=linux-x64|linux-arm64|macos-x64|macos-arm64|windows-x64`
     与 `--skip-web`；跨平台会明确报错（SEA 底座只能是当前这台机器的 Node）。
   - `server/sea.js`（新增）：`IS_SEA` / `sourceDir()` / `appDir()` / `isWritable()` /
     `configHome()`+`dataHome()`+`cacheHome()`（Linux/macOS/Windows 三平台各按本机 XDG 口径）/
     `assetKeys()`+`asset()` / `appMeta()` / `extractXetBinary()`（把内嵌 `bin/xet-dl` 释放到
     `cacheHome()/bin/<版本>/xet-dl`，chmod 755，先写 tmp 再 rename，文件被占用时退到带 pid 的文件名，结果进程内缓存）。
   - `server/webroot.js`（新增）：把内嵌 `web/**` 变成静态站（自带 MIME 表；`assets/` 前缀
     `public, max-age=31536000, immutable`，其余 `no-cache`；sha1 ETag + `If-None-Match` → 304；
     无扩展名的 GET 回 `index.html` 支持 SPA，带扩展名未命中返回 404）。非打包态返回 `null`，行为不变。
2. **服务端改造为两种形态共用一套代码**：
   - `server/index.js`：`SRC_DIR = sourceDir()`（打包后为空，避免 `fileURLToPath(undefined)` 崩）；
     静态托管三态「内嵌 Web → `dist/` → 提示先 build」；新增 `--help/-h`、`--version/-V`（读 `appMeta()`）；
     启动横幅新增「运行形态」行；**顶层 await 收进 `async function start()`**（SEA 的 main 是 CJS，不支持 TLA）。
   - `server/downloads.js`：去掉 `fileURLToPath`；下载目录改为 `defaultDownloadDir()`（源码运行仍是
     `cwd/downloads`；单文件优先可执行文件旁 `downloads/`，不可写退到用户数据目录）；Xet 下载器查找改为惰性
     候选链 `XET_DL_BIN` → 内嵌释放 → 可执行文件旁 → `cwd/native/...`（Windows 自动加 `.exe`）。
   - `server/settings.js`：默认 `<程序目录>/settings.json`，不可写退到用户配置目录；保存前 `mkdirSync`。
3. **依赖与元信息**：`package.json` 加 `packageManager: pnpm@12.21.0`、`scripts["package:sea"]`、
   `devDependencies.esbuild ^0.28.2`、`pnpm.onlyBuiltDependencies:["esbuild"]`；新建 `pnpm-workspace.yaml`
   同名配置；`pnpm-lock.yaml` 已用 pnpm 更新（未引入 npm/yarn 锁）；`.gitignore` 加 `build/`、`release-build/`。
4. **三平台 Release 工作流** `.github/workflows/release.yml`（新增，js-yaml 解析校验通过）：
   matrix = `ubuntu-22.04`→linux-x64、`macos-14`→macos-arm64、`windows-latest`→windows-x64；
   每块跑 `pnpm install --frozen-lockfile` → `cargo build --release --locked --target <triple>` →
   `node scripts/build-sea.mjs --target=…` → **冒烟测试**（起 exe，curl `/`、`/assets/index-*.js`、
   `/api/tasks`、`/api/config` 并校验内容；Windows 用 pwsh 同套断言）→ `upload-artifact`；
   `release` job 仅在推 `v*` 标签时把三平台产物（含 `.sha256`）汇总成一个 GitHub Release。
   触发：推 `v*` 标签，或工作流页面手动 `Run workflow`（只出 Artifacts 不发 Release）。
5. **文档**：README 新增「单文件版（Releases 下载）」（平台表、`chmod`/`xattr`/SmartScreen、下载目录与设置
   回退、xet-dl 释放路径、`.sha256` 校验、自己打单文件包的命令、CI 说明）与「命令行参数」一节；
   「目录结构」补 `server/sea.js`、`server/webroot.js`、`scripts/build-sea.mjs`、`.github/workflows/release.yml`。
6. **CI 三平台全绿并出 Release**（推 `v1.0.0` 标签触发，run `44912837325`）：Linux x86_64 / macOS Apple
   Silicon / Windows x86_64 三块 matrix 各自「编译 xet-dl → 打单文件 → 起进程做 HTTP 冒烟」全部通过，
   `release` job 汇总成 GitHub Release（6 个附件：3 个可执行 + 3 个 `.sha256`）。途中修掉三个只在 runner
   上暴露的问题，详见「验证与版本」：pnpm 12 的构建脚本白名单口径、macOS runner 标签、xet-dl 的 Windows 编译。
7. **`native/xet-dl/src/main.rs` 按平台取已落盘字节数**：原先无条件 `use std::os::unix::fs::MetadataExt` +
   `md.blocks()`，Windows（MSVC）上没有 `std::os::unix` 直接编译失败。改为 `allocated_bytes(&Metadata)`：
   `#[cfg(unix)]` 走 `blocks()*512`，`#[cfg(not(unix))]` 退到 `md.len()`（Windows 的稀疏统计语义不同，
   这里只用于「已下载多少」的展示与续传判断，取文件长度更直白）。调用处 `md.as_ref().map(allocated_bytes)`。
8. **依赖白名单改口径**：pnpm 12 不再读 `package.json` 里的 `pnpm` 字段，`onlyBuiltDependencies` 失效，
   CI 上 `pnpm install --frozen-lockfile` 会以 `ERR_PNPM_IGNORED_BUILDS(esbuild)` 失败。改为在
   `pnpm-workspace.yaml` 写 `allowBuilds: { esbuild: true }`，并从 `package.json` 删掉失效的 `pnpm` 字段。
   已在干净目录（`/tmp/citest3`，只有本仓 + `pnpm-lock.yaml`）复跑 `pnpm install --frozen-lockfile` 通过。
9. **macOS runner 标签**：`macos-14` 在本账号下被拒（annotation：The configuration
   'macos-14-arm64-us-default' is not supported），临时探测 workflow 实测 `macos-latest` ✓、`macos-15` ✓、
   `macos-14` ✗、`macos-13` 排队 10 分钟仍未分配（容量紧张）。matrix 定为 `macos-latest`，探测用的临时
   workflow 已删除。

### 未完成与挂账
- **产物体积 110–165 MB 未优化**：底座是 setup-node 装的官方 Node（未 strip），CI 包因此比本机自研包大一倍
  （Linux 166 MB vs 本机 82 MB）。要瘦身可选：① 打包前 `strip` 底座 Node；② 产物上 UPX（Windows 上 UPX 常被
  杀软误报，得先评估）。两者都会让「启动冒烟」重新变成必测项，暂未做。
- **产物不可复现**：同一份代码两次 CI 构建出的 Linux 包 sha256 不同
  （run `44910670041` 是 `122fda5c…`，run `44912837325` 是 `fa770abb…`），大小一致但字节不一致
  （SEA 内嵌资源顺序 / 构建时间戳进了镜像）。要可复现得固定 `SOURCE_DATE_EPOCH` 并核对打包脚本，未做；
  目前以「每次 Release 附件自带的 `.sha256`」为准，不跨版本对比。
- **macOS 未做公证 / Windows 未做代码签名**：macOS 只有 ad-hoc 签名（`codesign --sign -`），首次打开要
  `xattr -dr com.apple.quarantine`；Windows 首次运行会撞 SmartScreen「未知发布者」。买证书后需在 workflow
  里接 `codesign` + `notarytool` 与 `signtool`，未做。
- **macOS 只出 Apple Silicon（arm64）**：Intel mac（macos-x64）暂无 runner 覆盖，需要时补 `macos-13`。
- **Linux 基线是 glibc ≥ 2.35**（在 ubuntu-22.04 runner 上编译）：更老的发行版（CentOS 7 / Debian 11）
  跑不起来，README 平台表已注明；要更宽兼容需改为在静态 musl / 更老容器里构建，未做。

### 验证与版本
- **远端**：标签 `v1.0.0` 指向 `3046fec`（`+ 377474d...3046fec v1.0.0 -> v1.0.0 (forced update)`），
  `main` 在其后仅追加本轮文档提交。
- **CI run `44912837325`（推 `v1.0.0` 触发，由 Actions 自己发布）**：Linux x86_64 / macOS Apple Silicon /
  Windows x86_64 三块 matrix + `release` 汇总 job **全绿**，
  Release 页 https://github.com/cqwuxiaolong/hf-ui/releases/tag/v1.0.0 （publishedAt 2026-11-21T14:20:12Z，
  6 个附件：3 个可执行 + 3 个 `.sha256`）。
  在此之前 run `44910670041`（手动触发）已让三平台构建 + 冒烟全绿；`release` job 首次（run `44911542515`）
  因缺 checkout 报「failed to run git: fatal: not a git repository」，补 `GH_REPO` 后闭环。
- **Release 附件（`gh api …/releases/tags/v1.0.0` 的服务端 digest）**：
  `hf-ui-linux-x64` 166 571 136 B `fa770abb57d4bee198a606e49553624fdf6b7a22d1bd24f136b5e412d588a71a`、
  `hf-ui-macos-arm64` 158 719 120 B `3d20359145660875b7787afdafbeef114b36328f1ed20bee07078f83a684373c`、
  `hf-ui-windows-x64.exe` 115 102 536 B `0798d57c89fa7145da958fbb66e53ab469b562d0f63037b9577f742a2b49f7d1`。
  三个附件自带的 `.sha256` 内容与 GitHub 服务端算出的 digest **逐条一致**（打包脚本的校验文件没写错）。
  注：与上一版（run `44910670041` 的 Artifacts）字节不同属正常——不同 runner 上的 Node 底座与 Rust 构建，
  未做可复现构建。
- **CI 的 Linux 产物搬到本机（glibc 2.44）真跑通**（`/tmp/cirun`，端口 2274）：横幅「运行形态 → 单文件
  （目标 linux-x64，前端与 xet-dl 已内嵌）· 程序目录 /tmp/cirun」；`/` 200 text/html、`/api/tasks` 200、
  `/api/config` 200、`/assets/index-kU_0k8CQ.js` 200 且带 `ETag` 与 `Cache-Control: public, max-age=31536000, immutable`；
  真实下载 `HuggingFaceTB/SmolLM2-135M/model.safetensors` → **engine=xet、status done**，
  成品 269 060 552 B，内嵌下载器已释放到 `~/.cache/hf-web-manager/bin/1.0.0/xet-dl`（13 090 192 B，CI 那份 Rust 构建）。
- 本机自研出包：`node scripts/build-sea.mjs` → `release-build/hf-ui-linux-x64` **81 831 704 B**，
  `sha256 = 0b31b82e7f13f9a4451af04ec8f5efc78adc7dcf53173f0ecc9701936d3326ce`。
- **脱离仓库运行**（在 `/tmp/hfsearun` 启动 exe）：横幅显示「运行形态 → 单文件（目标 linux-x64…）」。
- HTTP 全绿：`/` 200（text/html 9 403 B，`Cache-Control: no-cache`）、`/index.html` 200、
  `/assets/index-kU_0k8CQ.js` 200（125 005 B，`public, max-age=31536000, immutable` + ETag）、
  `/assets/index-BfRwmCXB.css` 200、`/api/tasks` 200、`/api/config` 200、
  `/some/spa/path` 200（SPA 回退）、`/missing.png` 404。
- **真下载**：`distilbert/distilbert-base-uncased/config.json` → done（engine=fetch，落盘 483 B）；
  `HuggingFaceTB/SmolLM2-135M/model.safetensors` → **engine=xet**（证明内嵌下载器被释放并成功 spawn）。
- 内嵌下载器释放物：`~/.cache/hf-web-manager/bin/1.0.0/xet-dl`（13 236 104 B，`-rwxr-xr-x`，`--help` 正常）。
- **源码运行回归**：`node server/index.js`（PORT 2291）`/`、`/assets/*.js`、`/api/tasks`、`/api/config` 全 200，
  `/api/nope` 404；`node server/index.js --version` → `hf-web-manager 1.0.0 · 目标平台 source · Node 26.13.1 · 源码运行`。
- 依赖安装：`pnpm install --frozen-lockfile` 通过（`onlyBuiltDependencies` 已放行 esbuild 的构建脚本）。
- 工具与版本：pnpm 12.21.0、node v26.13.1、cargo/rustc 1.96.1、`gh 2.28.0`（账号 cqwuxiaolong）。

### 跳过项
- 本轮新增的验证全部走命令行（curl / 直接起 exe），**未安装任何桌面 app / GUI / 系统浏览器**，
  也不存在「因禁止安装桌面 app 而跳过」的项。
- Windows / macOS 产物本机无法验证（不在本机平台，且 SEA 不能交叉编译），只能依赖 CI 对应 runner 上的
  启动冒烟（起进程 + 校验首页/内嵌 js/`/api/config`）；本机 `cargo check --target x86_64-pc-windows-msvc`
  也做不了——build script 需要 MSVC `lib.exe`，本机没装（属禁止安装范围），所以 Windows 的 Rust 编译
  只能在 runner 上验证（已通过）。
- 因禁止安装桌面 app / GUI 浏览器，本轮所有验证走命令行（curl / 直接起可执行文件），无额外跳过项。
- 未做代码签名证书 / macOS 公证（仅 ad-hoc 签名），未加自动更新检查。

---

## 2026-11-21（第 5 轮）GitHub 建仓并推送

### 本次完成
1. **本地 git 首次提交**：此前仓库只有 `.git` 目录、零提交、零远端。`git add -A` 后入库 23 个文件共 420 KB
   （`node_modules`、`dist`、`downloads`、`settings.json`、`native/*/target`、`native/bin/` 全部按 `.gitignore` 排除）；
   主分支由 `master` 改名为 `main`；提交 `ab39041`「初始化提交：HF 模型搜索/下载管理器（Vite + Express + Rust Xet 下载器）」。
2. **GitHub 建仓 + 推送**：`gh repo create hf-ui --public --source=. --remote=origin --push`
   → https://github.com/cqwuxiaolong/hf-ui ，默认分支 `main`，本地 `main` 已设置跟踪 `origin/main`。
   仓库名取目录名 `hf-ui`，描述沿用 `package.json` 的 description。
3. **公开前的密钥扫描**（因为选了 public）：全库 `git grep` 无真实 `hf_*` / `ghp_*` / `gho_*` / `sk-*` 令牌，
   仅 `index.html:202`、`src/main.js:1783` 两处 `hf_xxxxx…` 占位符；含 `hfToken` 的 `settings.json` 本就在 `.gitignore` 里，未入库。

### 未完成与挂账
- 本轮为纯建仓/推送，无代码改动，也没有新闭环的旧挂账：第 4 轮条目里的挂账（掉电最坏 64 MiB 页缓存窗口是否补
  `sync_data()` 等）本轮未触碰，仍以下方条目为准。
- 两个默认值是我替你定的，需要改只需一条命令：可见性 `public`（与账号下自有仓一致）→
  `gh repo edit cqwuxiaolong/hf-ui --visibility private`；仓库名 `hf-ui` → GitHub 上改名后本地
  `git remote set-url origin https://github.com/cqwuxiaolong/<新名>.git`。

### 验证与版本
- 本地：`git log --oneline` → `ab39041`；`git rev-parse HEAD` = `ab3904106e0f8505e4ec164eb198a19ce2392897`；`git status` 干净。
- 远端：`git ls-remote origin` 的 `HEAD` 与 `refs/heads/main` 同为 `ab390410…92897`（远端 = 本地，无未推提交）。
- `gh repo view --json` → `visibility=PUBLIC`、`defaultBranchRef=main`、`isEmpty=false`、`createdAt=2026-11-21T12:36:15Z`。
- 工具：`gh 2.28.0`，账号 `cqwuxiaolong`（token scopes：gist / read:org / repo，HTTPS 协议）。

### 跳过项
- 只按「建仓 + 推送」执行，未创建 GitHub Projects / Issues / Labels / Releases，也未加 `.github/workflows` CI
  （未被要求，需要时再补）。
- 无「因禁止安装桌面 app 而跳过」的验证项；本轮全程命令行（`git` / `gh`），未安装任何新工具。

---

## 2026-11-20（第 4 轮）Xet 真续传落地（改代码 + 真跑验证）

### 本次完成
1. **`native/xet-dl`：`--resume [--meta <state.json>] [--trust-prefix <bytes>]`**（`src/main.rs`）
   - 只要开了 `--resume` 就走*流式*下载 `new_download_stream_group()` +
     `download_stream_blocking(file_info, Some(start..total))`：下游是 SequentialWriter 顺序队列，
     `blocking_next()` 出来的分片严格递增，文件长度恒等于「已写入前缀」→ 中途 `SIGKILL` 也是有效前缀。
     （`download_file_to_path_blocking` 是多连接随机偏移写，做不到，已放弃这条路。）
   - 续传状态文件 `{xetHash,fileSize,trusted,updatedAt}`：先写 `.tmp` 再 rename，每 64 MiB 更新一次；
     哈希或 fileSize 对不上就视为无效（不复用别人的半成品）。
   - 起点 = `max(状态 trusted, --trust-prefix)` 夹到 `[0, min(磁盘长度,total)]`；`start>0` 时
     `set_len(start)` 截掉尾部半个分片再 `seek` 追加。
   - 因为 Xet 的 range 重建只用 merkle hash + file_size、**不校验 sha256**，续传完成后自己整体算一次
     sha256（`sha2` crate，8 MiB 缓冲，期间 emit `verifying`，`XET_SKIP_SHA256_VERIFY=1` 可跳）。
     长度不符 / sha256 不匹配 → `CORRUPT` 标记 + error 消息带 `"corrupt":true`；普通中断不删文件。
   - `pnpm run build:native` 通过，产物 `native/bin/xet-dl`（13 236 104 B，19:45）。
2. **`server/downloads.js`**：`chooseEngine` 去掉「`existing>0` 就切 fetch」，Xet 可用就优先（两条路都能续传）；
   `downloadWithXet(task, existing)` 改 async：tmp 有半成品直接续，只有 `dest` 有内容（fetch 下的/手动放的）
   就零拷贝 `rename(dest → tmp)` 当种子并 `--trust-prefix`；NDJSON 新增 `start`（权威续传起点）与 `verifying`
   分支；暂停/取消/停滞/网络错一律**保留** tmp，只有 `corrupt` 或大小不符才连 tmp+state 一起删并归零；
   回退 fetch 的条件收紧为「非强制 xet 且未 corrupt 且 resumeFrom==0 且 downloaded==0」；
   状态文件目录 `~/.cache/hf-web-manager/xet-state/`（`XET_STATE_DIR` 可改，sha1(dest) 前 20 位命名）；
   `removeDownload` 只有 `deleteFile=1` 才删 dest+tmp+state，纯「移除」留着下次接着下；`serialize` 加 `verifying`。
   补上漏掉的 `import os from "node:os"`（第 3 轮的 `os.homedir()` 直接把服务起崩了，已修）。
3. **`src/main.js`**：删掉 `confirmXetLoss()`（不再丢进度）与只服务于它的 `findTaskById()`；继续按钮 tooltip 统一
   「接着已下载部分继续」；新增「校验中」状态（`STATUS_LABEL.verifying`，running+verifying 时显示）；
   删本地文件的提示改成「已下载部分一起删掉（之后要重头下）」。`pnpm build` → `dist/assets/index-kU_0k8CQ.js`。
4. **README 口径更新**：删掉 4 处「Xet 不支持续传 / 只能从头重下 / 只有从零开始的任务才走 Xet」，
   改成流式顺序落盘 + 64 MiB trusted + 整体 sha256 兜底的真实行为说明。
5. **回归脚本入库** `native/xet-dl/manual-tests/`（`go.sh`+`run.sh` 二进制级 / `e2e.sh` 服务端到端 / `restart.sh` + README，附本轮两份真实日志 `out.log`、`e2e.log`），
   测试目标 `Qwen/Qwen3-0.6B model.safetensors`（1.5 GB）—— **本机从未下过**（`~/Documents/basalt/models/` 下
   原先只有 `jesdga`、`klee100`），不拿已下好的模型自证；脚本跑完自己删测试文件。

### 验证与版本
- **二进制级 3 轮 SIGKILL**（`manual-tests/out.log`，全程 `kill -9`）：
  round1 `start.bytes=0` → 445 118 957 B 被杀，state `trusted=445118957`；
  round2 `start.bytes=resumeFrom=445118957`（不删文件、不截断）→ 1 018 531 840 B 被杀，`trusted=987318687`（保守小于磁盘长度）；
  round3 `resumeFrom=987318687` → `done`，退出码 0，最终长度 1 503 300 328，
  **实际 sha256 = 期望 `f47f7117…874b`**（工具内算 + 外部 `sha256sum` 双算一致），state 文件已被删除。
- **服务端到端**（`manual-tests/e2e.log`，端口 2270）：新任务 → 311 202 997 B 时 `POST /pause`
  → tmp 长度暂停前后一致、暂停 6 s 后仍不变，state 存在；`POST /resume` → 继续后 `downloaded` 仍是
  311 202 997（**不是 0**），随后涨到 512 MB → 1 050 MB → 1 188 MB（Xet 分片成批到达，进度呈台阶式跳涨）
  → `done`，目标文件 sha256 = 期望值，tmp 与 state 均已消失。
  删任务 `?deleteFile=1` 后成品/半成品/state 三清；再往 `dest` 预置 200 000 000 B 半成品新建任务 →
  `downloaded=201 029 818` 起（fetch 前缀播种生效，`dest` 被改名成 `.xet-partial`）。
- `GET /` 200、`GET /api/tasks` 200（任务列表已清空）、`node --check server/downloads.js`/`src/main.js` 通过、
  `cargo build --release` Finished、`vite build` ✓ 7 modules（125.00 kB）。
  测试残留已清理：`basalt/models/Qwen/` 无残留文件、`~/.cache/hf-web-manager/xet-state/` 为空。
- **收尾复核（同轮，无代码改动）**：2270 的 `node server/index.js`（pid 937420）启动于 19:40:35，晚于 `server/downloads.js` 的 19:40:20，确认服务跑的是含真续传的代码；`native/bin/xet-dl`（19:45:37）按任务 spawn，无需重启即生效。`GET /` 200、`GET /api/tasks` 200 且任务列表为空、state 目录为空，无残留。

### 未完成与挂账
- 续传状态只在**正常写循环里**每 64 MiB 落一次（状态文件本身 fsync，数据文件不 fsync）：
  进程被 `SIGKILL`（本轮两种场景都测过）没问题，但**整机掉电**时最坏有 64 MiB 页缓存未落盘，
  此时靠第 3 步的整体 sha256 判 corrupt 后从头重下。要不要在写 state 前 `sync_data()`（每次最多阻塞几秒）
  等用户定。
- 「校验中」的 sha256 对 GB 级文件要读一遍全文件（1.5 GB 实测约 1~2 s 走页缓存，冷缓存按磁盘速度），
  期间不更新 `downloaded`，仅靠 `verifying` 消息刷新停滞计时；未测 200 GB 级大文件的校验耗时上限。

### 跳过项
- 因禁止安装桌面 app / GUI 浏览器，跳过浏览器渲染验证；改用 `curl` 200 + `grep dist/assets/index-kU_0k8CQ.js`
  确认「校验中」「接着已下载部分继续」两条文案已进入产物（各命中）。
- 未测 `XET_MEMORY_BUDGET_MB` 调大 / 高性能模式开关下的续传（只影响并发与缓冲，不改续传路径）。

---

## 2026-11-20（第 3 轮）「暂停/继续」按钮与 Xet 续传现状核对（只读，未改代码）

### 本次完成
1. 明确口径：第 2 轮证伪的是「前缀无效」，**不等于现在支持续传**。当前实现里
   「继续」= 从 0 重下，而且暂停时连已下载的 `.xet-partial` 都会被删掉
   （`server/downloads.js` `downloadWithXet` 的 reject 路径 `fsp.rm(tmp, { force: true })`，约 676 行）。
2. 前端按钮核对（无需改动即与现状一致）：
   `src/main.js:1122-1131` running/queued/retrying 出「暂停」+「取消」；paused 出「继续」（tooltip 按引擎分流：
   `Xet 不支持续传：继续会从头重下` / `接着已下载部分继续`）+「取消」；
   `src/main.js:1354/1357` 「全部继续 / 全部暂停」；错误文案在 `server/downloads.js:759`
   （`runTask` 的 catch 里：「（Xet 不支持续传，重试会从头重下）」），`downloads.js:857`
   `resumeDownload` 的注释同口径；`downloads.js:893-895`（`removeDownload`）连 `.xet-partial` 一起删。
   （行号校正：上稿误写为「`downloads.js:894` 错误文案」，894 实为 removeDownload 删半成品。）
   `dist/assets/index-BLB46kNl.js`（11-17 02:50 构建）内含该文案 2 处，与 `src/main.js`（02:49）同步，`:2270` 已验证返回 200。

### 未完成与挂账
- 第 3 轮挂的「真续传实现（改 4 处）」**已于第 4 轮（2026-11-20）全部闭环**，见上一条。

### 验证与版本
- 只读核对，产物无变化；`dist` 哈希与上轮一致（`index-BLB46kNl.js` 125 417 B / `index-BfRwmCXB.css` 27 828 B）。

### 跳过项
- 未跑真实暂停→继续的端到端（要下载 GB 级文件，且当前实现下结论已由源码确定）。
- 因禁止安装桌面 app / GUI 浏览器而跳过浏览器渲染验证，改用 `curl` + `grep dist` 产物代替。

---

## 2026-11-20（第 2 轮）hf-xet 缓存/续传口径核实（只读验证，未改代码）

### 本次完成
1. **确认「hf-xet 下载没有可用的中断续传，也没有 chunk 缓存复用」——结论成立，但两条理由都要纠正。**
   - 实测 A（无 chunk 复用）：`google-t5/t5-small` `model.safetensors`（242 MB，Xet 存储）用 `native/bin/xet-dl`
     连续跑两次全新目标文件：`elapsedMs=12285` / `elapsedMs=12251`，两次都是整文件从零拉满速度，没有任何复用。
   - 实测 B（缓存目录不存在）：两次跑前后 `find ~/.cache/huggingface/xet -maxdepth 3 -type d` 完全一致
     （只有 `logs/` 与 5 月遗留的空 `staging/`）；`/tmp` 也没有新增 xet/chunk/shard 目录。
   - 实测 C（env 也开不了）：`HF_XET_CHUNK_CACHE_SIZE_BYTES=5000000000` 再跑一次，磁盘上依旧不产生任何 chunk 缓存目录。
   - 实测 D（python 侧同样不缓存）：`hf download google-t5/t5-small model.safetensors --cache-dir /tmp/hfcache`
     （15.5 s）跑完后 `~/.cache/huggingface/xet` 目录树零变化。
   - 源码证据（`~/.cargo/registry/src/mirrors.tuna.tsinghua.edu.cn-4dc01642fd091eda`，hf-xet **1.8.1**）：
     三个下载入口一律把 chunk cache 传 `None` ——
     `hf-xet-1.8.1/src/xet_session/file_download_group.rs:153`、
     `hf-xet-1.8.1/src/xet_session/download_stream_group.rs:147`、
     `hf-xet-1.8.1/src/legacy/data_client.rs:163` 全是 `FileDownloadSession::new(config, None)`；
     缓存实现方 `xet_client::chunk_cache::get_cache` 在 hf-xet/xet-data/xet-client 三 crate 内**零调用者**
     （只被 `xet-data-1.8.1/src/processing/mod.rs:23` re-export）；
     `xet-data-1.8.1/src/file_reconstruction/reconstruction_terms/xorb_block.rs:113/167` 的
     「先查盘上 chunk 缓存 / 下载后 best-effort put」两处都包在 `if let Some(cache)` 里，`None` 时既不读也不写；
     `xet-client-1.8.1/src/chunk_cache/mod.rs:88` 的 `CacheConfig::from_config` 把目录硬编码为 `/tmp`。
     → 缓存机制本体存在但没接线，且外部没有开关可打开它。
   - 纠正用户表述：缓存若启用**不在** hub/blob 里（hub 下只有最终文件与元数据；
     `~/.cache/huggingface/xet/logs` 里的 `cache_size_limit = 16GB / cache_subdir = "shard-cache"`
     是 `shard` 组的上游 shard 缓存，走 `xet-data-1.8.1/src/processing/shard_interface/native.rs`，与下载 chunk cache 无关）。
2. **纠正「.xet-partial 不是有效前缀」这条旧结论（含我仓里 `server/downloads.js:402` 注释的归因）。**
   - 源码：`xet-data-1.8.1/src/file_reconstruction/file_reconstructor.rs:136-163` 用
     `SequentialWriter`（`src/file_reconstruction/data_writer/sequential_writer.rs:228-230`
     注释 “out-of-order future resolution with **in-order writes**”），
     且 `download_file` 走 `reconstruct_to_file(path, None, /*truncate=*/true)` —— 打开即截断，所以重跑必然从 0，
     但落盘是**顺序追加**，不是随机偏移。
   - 实测：`klee100/Qwen3.8-Flash-Next-Uncensored-Basalt` 的 `Qwen3.8-FN-Uncensored-NVFP4-DQ8.basalt`
     （132 367 782 911 B）用 xet-dl 跑到 1 540 312 614 B 时 `kill -9`：
     `Size=1540312614 / Blocks=3008424`（×512 = 1 540 313 088 B，即 0 空洞），
     `SEEK_DATA/SEEK_HOLE` 扫描结果只有 **1 个 data extent (0, size)，hole 字节 0**；
     再用 CDN 签名 URL 的 `Range: bytes=0-1540312613`（HTTP 206）独立拉同样长度，
     两边 SHA256 均为 `00179a21a4cfa09e0d18457051327f43b8063bb3dc0dcac814373535490a43c2` —— **完全一致**。
   - 结论：半成品**就是有效的字节前缀**，按前缀长度做 range 续传在 Xet 上是可行的
     （库里有现成 API：`xet-data-1.8.1/src/processing/file_download_session.rs:386 download_to_writer(range, writer)`，
     或 `reconstruct_to_file(path, Some(offset), false)`）。现在不支持断点的原因是**实现里没写续传逻辑 + 打开就 truncate**，
     不是「前缀是坏的」。
3. 顺带复用了上一轮结论：token-refresh URL 必须裸斜杠（`%2F` 会让 hf-mirror 返 404
   “Xet repository alias could not be resolved”），`huggingface.co` 直连 curl 会挂住，统一走 `hf-mirror.com`。

### 未完成与挂账
- `server/downloads.js:402` 注释「`.xet-partial` 是并行分块写的，不是有效前缀，续传会写出坏文件」的**归因错误**
  （本轮已实测证伪）。行为不变（仍整块重来），仅注释需改写为「库打开目标即 truncate，且无 chunk 缓存，故整文件重来」。
  待用户同意后再改（本轮按要求未动代码）。
- 可选项：既然前缀有效，`xet-dl` 可加 `--resume`（按已存在长度取 range，走 `download_to_writer`）实现真断点续传；
  需先定口径（前缀尾部未 flush 部分、range 起点是否需对齐 chunk）再动手。
- 上轮遗留可选项未动：根目录 `Qwen3.8-FN-NVFP4-DQ6_K.basalt`（122.6 GB）是否挪进 `klee100/Qwen3.8-Flash-Next-Uncensored-Basalt/`；
  本地列表 `.cache` 组是否隐藏。

### 验证与版本
- hf-xet crate **1.8.1**（`native/xet-dl/Cargo.toml` 锁定 `hf-xet = 1.8.1`，`default-features=false` + `rustls-tls`；
  该 crate 提供 `no-default-cache` 特性，本次未启用）；python `hf_xet` 1.8.0（`/usr/lib/python3.14/site-packages/hf_xet/hf_xet.abi3.so`，
  `strings` 内含 `chunk cache put failed: ` 与 `HF_XET_CHUNK_CACHE_SIZE_BYTES`，即代码编进去但同样没接线）。
- 二进制 `native/bin/xet-dl`（12 938 040 B，2026-11-16 10:46）。
- 关键命令结论：t5-small 两次 12 285 ms / 12 251 ms；`kill -9` 大文件后 0 空洞；前缀 SHA256 与 CDN range 一致；
  `find ~/.cache/huggingface/xet` 前后无差异；`ls /tmp` 无新缓存目录。
- 服务：`:2270` 机器 11-17 重启后曾掉线，本轮已用 `setsid nohup pnpm start </dev/null >>~/hf-server-2270.log 2>&1 &` 拉起
  （node pid 895827）。`GET /` 200、`GET /api/tasks` 200（`{"tasks":[]}`）、`GET /api/config` 正常
  （`downloadDir=/home/cqwuxiaolong/Documents/basalt/models`，`hasToken=false`，`xetHighPerformance=false`，`xetMemoryBudgetMb=1024`）。
  本机非 git 仓库，无远端 SHA 可记。
- 临时产物已清理：`/tmp/xt/*.bin`、`/tmp/hfcache`（`/tmp` 现 748 M 已用 / 30 G 可用）。

### 跳过项
- 未做「真 range 续传」的功能实现与验证（本轮定位为只读核实口径，按要求不改代码）。
- 因禁止安装桌面 app / GUI 浏览器而跳过：前端页面（下载目录两层展示、XET_KEEP_HIGH_PERFORMANCE 开关等）的浏览器渲染验证，
  改用 `curl` 打 API 与检查 `dist/` 产物代替。
- 未复现「260 GB 级文件中途断掉后重跑」的全程耗时对比（成本 3 h+，已由 1.54 GB 前缀 + 242 MB 双跑 + 源码 truncate 逻辑三方印证）。
