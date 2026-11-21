# HF 模型管理器

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个基于 **pnpm + Vite + Express + @huggingface/hub** 的本地 Web 工具（默认端口 **2270**）：

- 🔍 搜索 Hugging Face 模型（默认走 `hf-mirror.com` 镜像）
- 📦 点击模型即可看到**全部文件与大小**（含 LFS 真实字节数）
- ⬇️ 选中文件 / 全选 / 下载全部，服务端下载到本地磁盘，大文件走 **Xet 多连接高速下载**（实测比直连快约一倍）
- 🔁 **网络失败自动重试**：传输中断 / 连接挂起 / 5xx 等瞬态错误自动重试（指数退避，默认 3 次）；耗尽后转为「出错」并显示具体原因，可手动重试。**两个引擎都接着已下载部分继续**（Xet 与直连都是真续传）
- ⏸ 下载任务支持**暂停 / 继续**：单任务暂停或「全部暂停」。「继续」无论 Xet 还是直连都**接着已下载部分继续**，已下好的字节不重下；Xet 续传完成后会再做一次整体 sha256 校验（界面上短暂显示「校验中」）
- 📋 右侧**浮动抽屉**查看**下载任务**（进度、速度、剩余时间、暂停 / 继续 / 取消 / 重试 / 删除），不占用主区域宽度
- 🗂 **自定义下载目录**（运行时修改，立即生效并持久化到 `settings.json`）
- 🖥 **内置目录选择器**：左侧「我的电脑」列出磁盘 / 主目录 / 常用目录，右侧浏览器式导航（面包屑、上一级、手动输入路径、新建文件夹），不调用系统 / Node 原生对话框
- 📄 **README / 模型卡片**：点击 README 文件或右上角「README」按钮，弹窗内渲染 Markdown（表格、代码、图片、相对链接自动指回镜像站）
- 🧹 **管理已下载的文件**：按仓库分组浏览、单文件 / 整组删除、复制完整路径、跳回模型页
- 🧽 **半成品不残留**：未下完的文件（含 Xet 的 `<文件>.xet-partial`）在文件列表显示「部分 X」并附「清理半成品」按钮；出错 / 已取消的任务卡上另有「删文件」，移除任务的同时清掉已下载的部分

## 快速开始

```bash
pnpm install

# 开发模式（前端 2270 + 后端 2271，自动热更新）
pnpm dev

# 生产模式（构建后由同一个服务托管，端口 2270）
pnpm build
pnpm start
```

打开 http://localhost:2270

## 单文件版（Releases 下载）

不想装 Node 也可以：[Releases](https://github.com/cqwuxiaolong/hf-ui/releases) 里每个平台**一个可执行文件**，
里面同时装了 Node 运行时、服务端、构建好的 Web 界面和 Rust 写的 Xet 下载器（Node SEA 内嵌资源）。
双击 / 命令行启动后同样打开 http://localhost:2270。

| 文件 | 平台 |
| --- | --- |
| `hf-ui-linux-x64` | Linux x86_64（glibc ≥ 2.35，Ubuntu 22.04 / Debian 12 / Fedora 38 起） |
| `hf-ui-macos-arm64` | Apple Silicon（在 GitHub 的 Apple Silicon runner 上构建） |
| `hf-ui-windows-x64.exe` | Windows 10 / 11 x86_64 |

包体 110–165 MB 左右：里面是一个完整的 Node 运行时（未 strip）加前端与下载器，暂未做 UPX / 压缩优化。

```bash
# Linux / macOS
chmod +x hf-ui-linux-x64            # macOS 拿到的是未公证的 ad-hoc 签名，被拦时再执行下一行
xattr -dr com.apple.quarantine hf-ui-macos-arm64
./hf-ui-linux-x64 --help            # 看所有环境变量；--version 看版本与内嵌信息
```

- Windows：首次运行若 SmartScreen 提示「未知发布者」，点「仍要运行」。
- 下载目录默认在可执行文件旁边的 `downloads/`；那一层不可写（如放进 `Program Files`）时自动改用到
  用户数据目录。设置文件同理（先试 `settings.json` 放在程序旁，只读时退到用户配置目录），
  也可用 `DOWNLOAD_DIR` / `SETTINGS_FILE` 明确指定。
- 内嵌的 Xet 下载器第一次用到时释放到用户缓存目录（Linux `~/.cache/hf-web-manager/bin/<版本>/xet-dl`，
  macOS `~/Library/Caches/hf-web-manager/…`，Windows `%LOCALAPPDATA%\hf-web-manager\cache\…`），
  想指定外部下载器仍可用 `XET_DL_BIN`。
- 附件里的 `.sha256` 用于校验下载完整性：`sha256sum -c hf-ui-linux-x64.sha256`。

### 自己打单文件包

```bash
pnpm install
# 1) 先编译内嵌的 Rust 下载器（Linux x64 为例）
cargo build --release --locked --target x86_64-unknown-linux-gnu --manifest-path native/xet-dl/Cargo.toml
mkdir -p native/bin && cp native/xet-dl/target/x86_64-unknown-linux-gnu/release/xet-dl native/bin/xet-dl
# 2) 出包（内含 vite build，产物在 release-build/）
pnpm run package:sea            # 或 node scripts/build-sea.mjs --target=windows-x64
```

单文件版不能跨平台交叉编译（底座就是当前这台机器上的 Node），三个平台的包由
`.github/workflows/release.yml` 在各自的 runner 上构建：推 `v*` 标签即自动出包并汇总成一个 Release，
也可以在工作流页面手动 `Run workflow`（只上传 Artifacts，不发 Release）。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `2270` | 生产服务端口 |
| `HOST` | `0.0.0.0` | 监听地址；只给本机用时建议设为 `127.0.0.1` |
| `HF_ENDPOINT` | `https://hf-mirror.com` | 镜像站地址，可改为 `https://huggingface.co` |
| `HF_TOKEN` | 空 | 访问私有 / 门控仓库所需的访问令牌，只作**启动时的初始值**；日常请在界面点顶部「未配置令牌 / 令牌 ✓」芯片配置，保存进 `settings.json` 的 `hfToken`（文件权限 0600，界面与接口只显示掩码） |
| `HF_ACCESS_TOKEN` | 空 | `HF_TOKEN` 的别名（与 huggingface 工具链一致），仅在 `HF_TOKEN` 为空时使用 |
| `DOWNLOAD_DIR` | `./downloads` | 下载目录初始值（也可在界面右栏修改）；单文件版默认改成可执行文件旁边的 `downloads/`，不可写时退到用户数据目录 |
| `MAX_CONCURRENT_DOWNLOADS` | `2` | 同时下载的任务数 |
| `SETTINGS_FILE` | `./settings.json` | 设置持久化文件路径；单文件版默认 `<可执行文件目录>/settings.json`，不可写时退到用户配置目录 |
| `DOWNLOAD_ENGINE` | `auto` | 下载引擎：`auto`（Xet 可用就用，否则 fetch）/ `xet`（强制 Xet）/ `fetch`（只用 Node） |
| `XET_DL_BIN` | 空 | 自定义 Rust 下载器路径（源码运行默认找 `native/bin/xet-dl`；单文件版默认释放内嵌的那份到用户缓存目录） |
| `STALL_TIMEOUT_XET_MS` | `600000` | Xet 任务的「无进展」判定窗口（Xet 要先攒满一整块 50–260 MB 才落盘一次，慢启动是正常的，所以比 fetch 宽松很多） |
| `XET_MEMORY_BUDGET_MB` | `1024` | 传给 Rust 下载器的 Xet 重建缓冲内存预算，控制并发缓冲上限；机器内存紧张时调小（如 `512`）。**界面右栏「Xet 下载调优」可直接改，环境变量只作首次的初始值** |
| `XET_KEEP_HIGH_PERFORMANCE` | 空 | 设置后保留 `HF_XET_HIGH_PERFORMANCE=1`（高性能：下载并发 64 → 124）。**界面右栏「高性能模式」勾选框就是它，勾选状态持久化后覆盖环境变量** |
| `XET_SPEED_WINDOW_MS` | `60000` | Xet 任务的速度平均窗口；Xet 按数据块批量落盘，窗口太短会频繁算出 0（界面显示 `—`） |


示例：

```bash
HF_TOKEN=hf_xxxx DOWNLOAD_DIR=/data/models pnpm start
```

## 下载引擎（Xet / fetch）

大文件下载走 Hugging Face 的 **Xet** 协议（多连接、服务端分块），由 `native/xet-dl` 这个 Rust 子进程完成
（依赖 crates.io 的 `hf-xet`），Node 侧只负责排队、进度、暂停/取消。实测同一文件、同一时段、同一镜像站：

| 引擎 | 结果 |
| --- | --- |
| Node `fetch` 单连接 | 498 MB / 112.6 s ≈ **4.4 MB/s** |
| Xet（Rust，多连接） | 498 MB / 49.2 s ≈ **10.1 MB/s** |

编译 Rust 下载器（需要本机有 cargo；产物路径会被自动探测）：

```bash
pnpm run build:native   # 产物 native/bin/xet-dl
```

行为说明：

- **Xet 真续传**：开了 `--resume` 的 `xet-dl` 走*流式*下载（`download_stream_blocking` + `SequentialWriter`），
  分片严格顺序落盘，所以 `<文件>.xet-partial` 的长度始终等于「已写入前缀」，中途被杀也是有效前缀。
  每写 64 MiB 往续传状态文件（`~/.cache/hf-web-manager/xet-state/<sha1>.json`，`XET_STATE_DIR` 可改）记一次
  `trusted` 字节数；重启任务时取 `max(状态文件 trusted, --trust-prefix)` 夹到磁盘长度，从那里接着下。
  上一轮如果是直连下的（或用户手动放过半成品），`dest` 里的整块内容会被零拷贝改名成 `.xet-partial` 当种子（`--trust-prefix`）。
  因为 Xet 的 range 重建只按 merkle hash + file_size、不校验 sha256，续传完成后必须由 `xet-dl` 自己整体算一次 sha256 兜底。
  只有长度不符或 sha256 不匹配才判定文件已坏（`corrupt`），这时才删半成品从头重下。
- Xet 下载先写 `<文件>.xet-partial`，大小校验通过后改名，中途失败不会留下看着完整的目标文件。
- 残留的半成品都能在界面上删掉：文件列表的「部分 X」右侧「清理半成品」（走 `DELETE /api/local`），
  或出错 / 已取消任务卡上的「删文件」（走 `DELETE /api/tasks/:id?deleteFile=1`）；纯「移除」只删任务记录，
  `<文件>.xet-partial` 与续传状态都留着，之后下载同一文件会接着下。
- 文件不在 Xet 存储（拿不到 `x-xet-hash`）、或没编译 Rust 二进制时，`auto` 模式自动回退 fetch；
  `DOWNLOAD_ENGINE=xet` 则直接报错，便于排查。
- Xet 任务期间落盘量是按已分配块数估算的，进度条可能跳一大段再停顿，属正常现象。
  同理，界面右上角的「速度 / 剩余时间」是平均值：取最近 60 秒窗口的落盘增量，窗口里刚好没有数据块落地时
  退回「本次尝试以来的总均值」，所以进度在涨就不会显示 `—`（`XET_SPEED_WINDOW_MS` 可调窗口）。
- **内存预算**：hf-xet 的重建缓冲默认按「机器总内存」推导（总缓冲≈RAM/16、单文件≈RAM/64、上限≈RAM/4），
  它只看 cgroup 限额，不看实际可用内存。本机如果内存已被推理进程（如 basalt）占满，几百 MB～GB 的申请会直接把
  下载子进程撑爆（表现为任务长期 0 字节、子进程反复重开重试）。因此 `xet-dl` 启动时会把缓冲三项压到
  `XET_MEMORY_BUDGET_MB`（默认 1024）预算内；全部变量都只在调用方未设置时才写，想自己调就显式导出同名 `HF_XET_RECONSTRUCTION_*`。
- **高性能模式（右栏勾选框）**：等价于保留 `HF_XET_HIGH_PERFORMANCE`。真实收益是并发——下载并发上限 64 → 124、
  起始并发 4 → 16、同时摄取文件 100；它的副作用（缓冲按总内存推导：60 GB 机器 ≈ 7.5 GB / 1.875 GB / 30 GB，
  正是 OOM 元凶）被上面显式写的预算覆盖掉——xet-runtime 是「先套 HP 预设、再套环境变量覆盖」，显式值必胜，
  所以**开着高性能内存仍然只有预算那么大**。取消勾选时 Rust 侧会把 `HF_XET_HIGH_PERFORMANCE` / `HF_XET_HP`
  从子进程环境里删掉，避免用户 shell 里的 `export` 悄悄把内存拉爆。
  实测（498 MB 文件、同一镜像站、内存仅剩 5 GB 可用）：默认旧行为（HP 生效 + 按内存推导缓冲）20 s 仍 0 字节且 RSS 871 MB+；
  预算 1024 MB / 并发 64 → 45.8 s ≈ 10.9 MB/s，RSS 295 MB；预算 512 MB / 并发 24 → 57.4 s ≈ 8.7 MB/s，RSS 123 MB。

## 使用说明

1. 左侧输入关键字（或直接粘贴 `owner/name`）搜索，点击结果选中模型。搜索框**记住最近 12 条历史**（存在浏览器
   `localStorage` 的 `hf.searchHistory`）：点输入框弹出历史，点某条直接搜它，每条右侧的小叉叉删除该条，右上角「全部删除」清空。
2. 仓库信息里的**基础模型**是可点的：多个基础模型（接口给数组，或一个逗号 / 分号拼接的串）会**自动拆成一人一个按钮**，
   点哪个就把哪个填进搜索框并打开那个仓库（`owner/name` 直接打开，不像仓库 ID 的当关键字搜），Shift+点击复制该名字。
3. 中间区域显示仓库总大小、每个文件大小、本地是否已存在，以及作者 / 任务类型 / 库 / 许可证 / 基础模型 / 创建与更新时间 / 下载量 / 提交 SHA 等仓库信息；基础模型可能有多个：每个名字是独立按钮，点哪个就只填哪个 / 打开哪个仓库，Shift+点击复制该名字；名字过长自动换行。
4. 点文件名 `README.md` 或右上角「README」可在弹窗中查看渲染后的模型卡片；`Esc`、右上角 ✕ 或点遮罩关闭。图片与相对链接会自动解析到镜像站；门控 / 私有仓库的内嵌图片需要配置有权限的 `HF_TOKEN`。
5. 勾选文件后点「下载选中」，或直接点某一行的「下载」；「直链」按钮可复制镜像站原始链接。
6. 右侧「下载任务」是**浮动抽屉**：展开时覆盖在内容上方，收起后完全滑出屏幕，只在右侧中部留一个悬浮的「⇩ 任务」小按钮（带任务数角标）——两种状态都不占主区域宽度，内容宽度不会变化。状态会自动记忆：首次访问时只有存在任务才默认展开，开始新的下载会自动展开。
7. 抽屉内「已下载文件」按仓库分组（组名就是 `owner/repo`）列出磁盘上的文件，可删除单文件或整个仓库目录，也可点「查看模型」跳回对应仓库。
8. 抽屉顶部可修改下载目录；修改只影响之后新建的任务，已下载文件保留在原目录。
9. 抽屉的「Xet 下载调优」：勾选「高性能模式」把下载并发从 64 提到 124；「内存预算」是 xet 子进程的缓冲上限（128 ~ 32768 MB）。
   两项立刻写入 `settings.json` 并对**之后新建 / 重启的任务**生效，正在跑的任务不受影响。
10. 点顶部「未配置令牌」/「令牌 ✓」芯片可配置 HF 访问令牌：弹窗里粘贴令牌（可勾选「显示」核对），保存前会先向镜像站
   `/api/whoami-v2` 校验一次，无效直接报错且不落盘；「清除令牌」= 明确不使用令牌，**此后连启动时的 `HF_TOKEN` 环境变量也一起忽略**
   （`settings.json` 里的 `hfToken: ""` 是权威值）。令牌只存本机，任何接口都只返回掩码（如 `hf_abcde…wxyz（37 位）`）。
11. 点「📁 选择目录」打开内置目录选择器：
   - 左侧「我的电脑」列出根目录、主目录、下载 / 文档 / 桌面，以及 `/proc/mounts` 中识别到的真实磁盘；
   - 右侧双击文件夹进入，支持面包屑跳转、`↑` 上一级、路径输入框直接前往、`刷新`、`显示隐藏`；
   - 可「＋ 新建文件夹」，右下角「选择此目录」立即切换下载目录并关闭弹窗（`Esc` 或点遮罩关闭）。

> 续传只对**直连（fetch）**任务有效，且依赖镜像 CDN 对 `Range` 的支持：支持时接着已下载部分下，不支持时自动从头重下（不会产生损坏文件）。
> **Xet 任务不支持任何续传**：暂停 / 中断 / 重试都从头重下，所以别在 Xet 大文件跑到一半时重启服务。
> 已下载文件是否完整以文件系统实际大小与仓库记录的大小对比为准。

### 文件存在哪里

下载目录下的结构与 Hugging Face 一致，两层：**`<下载目录>/<owner>/<repo>/<仓库内路径>`**。
例如 `klee100/Qwen3.8-Flash-Next-Uncensored-Basalt` 的文件落在
`models/klee100/Qwen3.8-Flash-Next-Uncensored-Basalt/Qwen3.8-FN-Uncensored-NVFP4-DQ8.basalt`。

> 老版本把仓库名里的 `/` 写成 `__`（`klee100__Some-Model`）。启动时会自动把这些目录升级成
> `klee100/Some-Model` 两层结构（同一文件系统内的 `rename`，瞬时完成，不复制文件）；
> 万一升级失败（跨盘 / 目标同名 / 权限），列表仍然认识老的 `__` 目录，不会显示成「未下载」。

## 目录结构

```
server/
  index.js      # Express 路由与静态托管（--help / --version / 启动横幅）
  sea.js        # 单文件（Node SEA）支持层：是否打包态、程序所在目录、配置/数据/缓存目录、内嵌资源读取、释放 xet-dl
  webroot.js    # 单文件版把内嵌的 dist/** 当静态站托管（MIME、ETag/304、immutable、SPA 回退）
  hf.js         # 模型搜索、文件列表、直链生成（@huggingface/hub）
  downloads.js  # 下载任务队列、进度、双引擎（Xet / 直连）、下载目录设置、老目录升级
  local.js      # 已下载文件扫描（按 owner/repo 分组）与删除（含路径越界保护）
  fsbrowse.js   # 目录选择器后端：磁盘根目录、列目录、新建文件夹
  settings.js   # settings.json 读写
native/
  xet-dl/       # Rust Xet 下载器（Cargo 包，NDJSON 进度）
  bin/xet-dl    # 编译产物（可选，缺失时自动回退 fetch）
scripts/
  build-sea.mjs # 出单文件包：vite build → esbuild 打包 server → 组装内嵌资源 → node --build-sea → sha256
.github/
  workflows/release.yml  # 三平台（linux-x64 / macos-arm64 / windows-x64）构建 + 冒烟测试 + 汇总 Release
src/
  main.js       # 前端逻辑（原生 JS）
  style.css     # 样式
index.html
vite.config.js
```

## 命令行参数

`node server/index.js`（源码运行）与单文件可执行文件支持同一组参数：

| 参数 | 说明 |
| --- | --- |
| `-h` / `--help` | 打印用法与全部环境变量（变量名与上面的表格一致） |
| `-V` / `--version` | 打印版本、目标平台、Node 版本、是否单文件运行 |

启动横幅也会显示当前「运行形态」：单文件（含目标平台与内嵌 Web 文件数）或源码运行。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 当前配置、下载目录、磁盘剩余空间，以及令牌状态 `token:{hasToken,source,hint}`（`source` ∈ `settings`/`env`/`cleared`/`none`，`hint` 为掩码） |
| POST | `/api/config` | 局部更新：`{ "downloadDir": "/abs/path" }` 改目录；`{ "xetHighPerformance": true/false }` 高性能开关；`{ "xetMemoryBudgetMb": 1024 }` 内存预算；`{ "hfToken": "hf_xxx" }` 保存令牌（先向镜像站校验，无效返回 400 且不写入；空串表示明确不用令牌）；可一次带多个，返回完整配置 |
| GET | `/api/token` | 令牌状态 + 掩码 + 镜像站 whoami 校验结果（`{hasToken,source,hint,verified,user}`，5 分钟缓存；**从不返回令牌原文**） |
| GET | `/api/search?q=&sort=&limit=` | 搜索模型 |
| GET | `/api/model?repo=owner/name` | 单个模型信息 |
| GET | `/api/files?repo=owner/name` | 文件列表（大小 / 直链 / 本地状态） |
| GET | `/api/readme?repo=owner/name` | README 原文（Markdown），服务端缓存 10 分钟 |
| GET | `/api/tasks` | 下载任务列表 |
| POST | `/api/tasks` | `{ "repo", "file", "size" }` 新建下载任务 |
| POST | `/api/tasks/:id/cancel` | 取消任务（已下载部分保留，可用「删文件」清理） |
| POST | `/api/tasks/:id/pause` | 暂停任务（排队中或下载中，已下载部分保留） |
| POST | `/api/tasks/:id/resume` | 继续已暂停的任务（直连接着下；Xet 从头重下） |
| DELETE | `/api/tasks/:id?deleteFile=1` | 移除任务，可选删除文件 |
| POST | `/api/tasks/cancel-all` | 取消全部进行中的任务 |
| POST | `/api/tasks/pause-all` | 暂停全部排队中 / 下载中的任务 |
| POST | `/api/tasks/resume-all` | 继续全部已暂停的任务（Xet 任务同样从头重下） |
| GET | `/api/local` | 扫描下载目录中的文件 |
| DELETE | `/api/local?path=<相对路径>` | 删除下载目录中的文件 / 目录 |
| GET | `/api/fs/roots` | 目录选择器左侧「我的电脑」根节点（磁盘 / 主目录 / 常用目录） |
| GET | `/api/fs/list?path=<绝对路径>` | 列出目录下的子文件夹、上级路径、所在磁盘容量 |
| POST | `/api/fs/mkdir` | `{ "path": "/parent", "name": "new-folder" }` 新建文件夹 |
| GET | `/api/events` | SSE：任务进度实时推送 |

## 备注

- `settings.json`、`downloads/` 已加入 `.gitignore`。
- 删除接口只允许操作下载目录内的路径，并对 `..` 等越界路径做了拦截。
- `/api/fs/*` 会读取本机目录结构，仅适合本机 / 可信网络使用。默认监听 `0.0.0.0`，如需限制为本机访问：
  ```bash
  HOST=127.0.0.1 pnpm start
  ```

## 许可

本项目基于 **MIT 协议** 开源，详见 [LICENSE](LICENSE)。
简言之：你可以自由使用、复制、修改、合并、出版、分发、再授权及/或销售本软件的副本，
只需在副本或重要部分中保留版权声明与本许可声明；软件按「现状」提供，不含任何明示或暗示的保证。
