# STATUS

滚动收尾状态文档：最新条目在最上方。历史全文见本文件（本仓已入 git，历史全文同时由 git 历史承载）。

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
