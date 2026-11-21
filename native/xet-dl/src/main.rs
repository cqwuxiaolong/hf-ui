//! xet-dl —— 用 hf-xet（Rust 版 Xet 客户端）下载单个 Hugging Face 文件。
//!
//! 用法：
//!   xet-dl --xet-hash <hex> --file-size <bytes> --dest <path> \
//!          --token-refresh-url <url> [--sha256 <hex>] [--auth-token <token>] \
//!          [--cache-dir <path>] [--progress-interval-ms <n>] \
//!          [--resume [--meta <state.json>] [--trust-prefix <bytes>]]
//!
//! stdout 每行一个 JSON（NDJSON），供 Node 端解析驱动进度条：
//!   {"type":"start","total":123,"bytes":0,"resumeFrom":0,"pid":42}
//!   {"type":"progress","bytes":456,"total":123,"elapsedMs":5000}
//!   {"type":"done","bytes":123,"elapsedMs":60000}
//!   {"type":"error","message":"...","corrupt":true}   // corrupt=true：文件已坏，调用方应删掉半成品
//! 出错退出码 1，成功 0。

use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use xet::xet_session::{
    HeaderMap, HeaderValue, XetFileInfo, XetSession, XetSessionBuilder, header,
};

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn emit(line: &str) {
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    let _ = writeln!(lock, "{line}");
    let _ = lock.flush();
}

/// 文件已损坏标记（长度不符 / sha256 不匹配）。置位后错误消息里会多出 `"corrupt":true`，
/// 调用方据此删除半成品；普通网络错误不带这个标记，半成品要留着下次续传。
static CORRUPT: AtomicBool = AtomicBool::new(false);

fn mark_corrupt() {
    CORRUPT.store(true, Ordering::SeqCst);
}

fn emit_error(msg: &str) {
    if CORRUPT.load(Ordering::Relaxed) {
        emit(&format!(
            "{{\"type\":\"error\",\"message\":\"{}\",\"corrupt\":true}}",
            json_escape(msg)
        ));
    } else {
        emit(&format!("{{\"type\":\"error\",\"message\":\"{}\"}}", json_escape(msg)));
    }
}

struct Args {
    xet_hash: String,
    sha256: Option<String>,
    file_size: u64,
    dest: PathBuf,
    token_refresh_url: String,
    auth_token: Option<String>,
    cache_dir: Option<PathBuf>,
    progress_interval: Duration,
    /// 断点续传：保留 dest 已有内容，从「已信任前缀」末尾接着下
    resume: bool,
    /// 续传状态文件（{xetHash, fileSize, trusted}），由本进程独占读写
    meta: Option<PathBuf>,
    /// 调用方声明的可信前缀字节数（把已下载好的前缀改名过来当种子时用）
    trust_prefix: u64,
}

fn usage(code: i32) -> ! {
    let text = "用法: xet-dl --xet-hash <hex> --file-size <bytes> --dest <path> --token-refresh-url <url> \
                [--sha256 <hex>] [--auth-token <token>] [--cache-dir <path>] [--progress-interval-ms <n>] \
                [--resume [--meta <state.json>] [--trust-prefix <bytes>]]";
    if code == 0 {
        println!("{text}");
    } else {
        eprintln!("{text}");
    }
    std::process::exit(code);
}

fn parse_args() -> Args {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut xet_hash = None;
    let mut sha256 = None;
    let mut file_size = None;
    let mut dest = None;
    let mut token_refresh_url = None;
    let mut auth_token = None;
    let mut cache_dir = None;
    let mut progress_interval_ms: u64 = 500;
    let mut resume = false;
    let mut meta = None;
    let mut trust_prefix: u64 = 0;

    let mut i = 0;
    while i < argv.len() {
        let flag = argv[i].clone();
        let value = |name: &str, argv: &[String], i: &mut usize| -> String {
            *i += 1;
            match argv.get(*i) {
                Some(v) => v.clone(),
                None => {
                    eprintln!("缺少 {name} 的值");
                    std::process::exit(2);
                }
            }
        };
        let mut take = || value(flag.as_str(), &argv, &mut i);
        match flag.as_str() {
            "--xet-hash" => xet_hash = Some(take()),
            "--sha256" => sha256 = Some(take()),
            "--file-size" => {
                let v = take();
                file_size = Some(v.parse::<u64>().unwrap_or_else(|_| {
                    eprintln!("--file-size 需要是整数，收到: {v}");
                    std::process::exit(2);
                }));
            }
            "--dest" => dest = Some(PathBuf::from(take())),
            "--token-refresh-url" => token_refresh_url = Some(take()),
            "--auth-token" => auth_token = Some(take()),
            "--cache-dir" => cache_dir = Some(PathBuf::from(take())),
            "--progress-interval-ms" => {
                let v = take();
                progress_interval_ms = v.parse::<u64>().unwrap_or(500);
            }
            "--resume" => resume = true,
            "--meta" => meta = Some(PathBuf::from(take())),
            "--trust-prefix" => {
                let v = take();
                trust_prefix = v.parse::<u64>().unwrap_or_else(|_| {
                    eprintln!("--trust-prefix 需要是整数，收到: {v}");
                    std::process::exit(2);
                });
            }
            "-h" | "--help" => usage(0),
            other => {
                eprintln!("未知参数: {other}");
                usage(2);
            }
        }
        i += 1;
    }

    Args {
        xet_hash: xet_hash.unwrap_or_else(|| {
            eprintln!("缺少 --xet-hash");
            usage(2)
        }),
        sha256,
        file_size: file_size.unwrap_or(0),
        dest: dest.unwrap_or_else(|| {
            eprintln!("缺少 --dest");
            usage(2)
        }),
        token_refresh_url: token_refresh_url.unwrap_or_else(|| {
            eprintln!("缺少 --token-refresh-url");
            usage(2)
        }),
        auth_token,
        cache_dir,
        progress_interval: Duration::from_millis(progress_interval_ms.max(50)),
        resume,
        meta,
        trust_prefix,
    }
}

/// hf-xet 的下载缓冲区默认值是**按机器总内存**推导的（`xet-runtime/src/utils/system_memory.rs`：
/// buffer=总内存/16、limit=总内存/4，且只看 cgroup 上限、不看实际可用量）。这台机器总内存 60 GB、
/// 但常驻推理进程占掉 55 GB，于是 hf-xet 一上来就申请几百 MB～几 GB 缓冲，被内核杀掉，
/// 表现为「0 B / 0.0%」反复重试。这里显式压成一个可控的小预算，并把「单次 fetch 大小」调小 ——
/// 后者同时决定落盘粒度，否则 destination 几分钟都是 0 字节，进度条和卡死看门狗都会误判。
///
/// 所有值都只在调用方没设置时才写，可用同名环境变量覆盖；总预算用 `XET_MEMORY_BUDGET_MB` 调。
fn apply_xet_defaults() -> String {
    const MB: u64 = 1_000_000;
    let budget = std::env::var("XET_MEMORY_BUDGET_MB")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v >= 64)
        .unwrap_or(1024)
        .saturating_mul(MB);

    // 高性能模式 = 前端「Xet 高性能」开关（server 会把它翻译成 XET_KEEP_HIGH_PERFORMANCE=1）。
    // 开着就保留 HF_XET_HIGH_PERFORMANCE：真正的收益是并发上限 64 → 124、起始并发 4 → 16
    // （xet-runtime/src/config/xet_config.rs::with_high_performance）。
    // 它的副作用是把缓冲三项按机器总内存推导（60 GB 机器 ≈ 7.5 GB / 1.875 GB / 30 GB，OOM 元凶），
    // 所以下面照样按 budget 显式写死缓冲 —— env 覆盖在 HP 预设之后应用，显式值必胜，
    // 于是「并发拉满 + 内存仍有界」。关掉开关时删掉 HP 变量，回到默认并发。
    let hp = std::env::var_os("XET_KEEP_HIGH_PERFORMANCE").is_some();
    let mut removed: Vec<&str> = Vec::new();
    if !hp {
        for name in ["HF_XET_HIGH_PERFORMANCE", "HF_XET_HP"] {
            if std::env::var_os(name).is_some() {
                std::env::remove_var(name);
                removed.push(name);
            }
        }
    }

    let targets: [(&str, u64); 6] = [
        ("HF_XET_RECONSTRUCTION_DOWNLOAD_BUFFER_SIZE", budget / 2),
        ("HF_XET_RECONSTRUCTION_DOWNLOAD_BUFFER_PERFILE_SIZE", budget / 4),
        ("HF_XET_RECONSTRUCTION_DOWNLOAD_BUFFER_LIMIT", budget),
        ("HF_XET_RECONSTRUCTION_MIN_PREFETCH_BUFFER", budget / 4),
        // 落盘粒度：小 → 进度更新快、内存峰值低；太小会拖慢吞吐
        ("HF_XET_RECONSTRUCTION_MIN_RECONSTRUCTION_FETCH_SIZE", (budget / 16).max(8 * MB)),
        ("HF_XET_RECONSTRUCTION_MAX_RECONSTRUCTION_FETCH_SIZE", (budget / 4).max(32 * MB)),
    ];

    let mut applied: Vec<String> = Vec::new();
    for (name, bytes) in targets {
        if std::env::var_os(name).is_some() {
            applied.push(format!("{name}=<继承>"));
            continue;
        }
        std::env::set_var(name, bytes.to_string());
        applied.push(format!("{name}={}", bytes / MB));
    }

    // 下载并发：HP 开 → 124/4/16（与 HP 预设一致），关 → xet 默认 64/1/4。
    let conc: [(&str, &str); 3] = if hp {
        [
            ("HF_XET_CLIENT_AC_MAX_DOWNLOAD_CONCURRENCY", "124"),
            ("HF_XET_CLIENT_AC_MIN_DOWNLOAD_CONCURRENCY", "4"),
            ("HF_XET_CLIENT_AC_INITIAL_DOWNLOAD_CONCURRENCY", "16"),
        ]
    } else {
        [
            ("HF_XET_CLIENT_AC_MAX_DOWNLOAD_CONCURRENCY", "64"),
            ("HF_XET_CLIENT_AC_MIN_DOWNLOAD_CONCURRENCY", "1"),
            ("HF_XET_CLIENT_AC_INITIAL_DOWNLOAD_CONCURRENCY", "4"),
        ]
    };
    for (name, value) in conc {
        if std::env::var_os(name).is_some() {
            applied.push(format!("{name}=<继承>"));
            continue;
        }
        std::env::set_var(name, value);
        applied.push(format!("{name}={value}"));
    }

    format!(
        "budgetBytes={budget};hp={hp};{} {}",
        if removed.is_empty() {
            String::new()
        } else {
            format!("; removed={}", removed.join(","))
        },
        applied.join(", ")
    )
}

// ─────────────────────────── 断点续传辅助 ───────────────────────────

/// 续传起点向下取整的粒度。Xet 流式下载严格顺序落盘，理论上任意字节都能续；但进程被杀 /
/// 掉电时最后一次写入的尾巴可能撕裂，起点向下让几 MB 重下最稳。
const RESUME_ALIGN: u64 = 4 * 1024 * 1024;
/// 每写这么多字节更新一次续传状态文件（掉电后最多重下这么多）。
const META_INTERVAL: u64 = 64 * 1024 * 1024;

fn align_down(x: u64) -> u64 {
    x - x % RESUME_ALIGN
}

/// 极简 JSON 取值（只为本工具的状态文件服务，不为一个四行文件引入 serde_json）。
/// 支持字符串与数字两种值，找不到返回 None。
fn json_raw_value<'a>(s: &'a str, key: &str) -> Option<&'a str> {
    let pat = format!("\"{key}\"");
    let mut rest = s;
    while let Some(pos) = rest.find(&pat) {
        let tail = rest[pos + pat.len()..].trim_start();
        let Some(after_key) = tail.strip_prefix(':') else {
            rest = &rest[pos + pat.len()..];
            continue;
        };
        let val = after_key.trim_start();
        if let Some(inner) = val.strip_prefix('"') {
            let b = inner.as_bytes();
            let mut i = 0usize;
            while i < b.len() {
                match b[i] {
                    b'\\' => i += 2,
                    b'"' => return Some(&inner[..i]),
                    _ => i += 1,
                }
            }
            return None;
        }
        let end = val
            .find(|c: char| c == ',' || c == '}' || c == ']' || c.is_whitespace())
            .unwrap_or(val.len());
        return Some(val[..end].trim());
    }
    None
}

fn json_str_field(s: &str, key: &str) -> Option<String> {
    json_raw_value(s, key).map(|v| v.to_string())
}

fn json_u64_field(s: &str, key: &str) -> Option<u64> {
    json_raw_value(s, key)?.parse::<u64>().ok()
}

/// 写续传状态：{xetHash, fileSize, trusted, updatedAt}。先写 .tmp 再 rename，
/// 保证状态文件本身不会留下半截。
fn write_meta(args: &Args, trusted: u64) {
    let Some(path) = args.meta.as_ref() else { return };
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(parent);
        }
    }
    let updated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let body = format!(
        "{{\"xetHash\":\"{}\",\"fileSize\":{},\"trusted\":{},\"updatedAt\":{}}}\n",
        json_escape(&args.xet_hash),
        args.file_size,
        trusted,
        updated_at
    );
    let tmp = PathBuf::from(format!("{}.tmp", path.display()));
    let done = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp)
        .and_then(|mut f| f.write_all(body.as_bytes()).and_then(|_| f.sync_all().or_else(|e| {
            // 少数文件系统不支持 fsync，写入本身已成功就别当失败
            if e.kind() == std::io::ErrorKind::InvalidInput { Ok(()) } else { Err(e) }
        })))
        .and_then(|_| std::fs::rename(&tmp, path));
    if done.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

fn remove_meta(args: &Args) {
    if let Some(path) = args.meta.as_ref() {
        let _ = std::fs::remove_file(path);
    }
}

/// 算出本轮该从哪个字节开始下。返回 0 表示从头下（调用方会清空已有文件）。
/// 取「状态文件的 trusted」「调用方声明的 --trust-prefix」里较大者，再夹到实际磁盘长度和
/// 文件大小以内。trusted 是我们自己按分片边界写进去的，本身就是完整前缀，不再额外对齐
/// （对齐只会白重下几 MB）；只有「看起来已经下完」时才用 align_down 退回去一小段重下，
/// 顺带把整体校验走完。
fn compute_resume_start(args: &Args) -> u64 {
    let total = args.file_size;
    if total == 0 {
        return 0;
    }
    let on_disk = std::fs::metadata(&args.dest).map(|m| m.len()).unwrap_or(0);
    let mut trusted = args.trust_prefix;
    if let Some(path) = args.meta.as_ref() {
        if let Ok(text) = std::fs::read_to_string(path) {
            let hash_ok = json_str_field(&text, "xetHash").as_deref() == Some(args.xet_hash.as_str());
            let size_ok = json_u64_field(&text, "fileSize") == Some(total);
            if hash_ok && size_ok {
                if let Some(t) = json_u64_field(&text, "trusted") {
                    trusted = trusted.max(t);
                }
            }
        }
    }
    let mut start = trusted.min(on_disk).min(total);
    if start >= total {
        // 已经全下完了也别零流量收工：留最后一小段重下，顺带把整体校验走完
        start = align_down(total - 1);
    }
    start
}

fn run(args: &Args) -> Result<(), String> {
    let xet_config = apply_xet_defaults();
    let total = args.file_size;
    // 续传起点：0 = 从头下（清空已有文件）；>0 = 保留前缀，从对齐后的位置接着下
    let resume_from = if args.resume {
        compute_resume_start(args)
    } else {
        0
    };
    if resume_from == 0 && args.dest.exists() {
        // 从头下：先删掉半截文件或上一轮成品，避免被当成有效前缀
        std::fs::remove_file(&args.dest).map_err(|e| format!("清理旧文件失败: {e}"))?;
        remove_meta(args);
    }
    if let Some(parent) = args.dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }

    let mut headers = HeaderMap::new();
    if let Some(token) = args.auth_token.as_deref() {
        let value = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|e| format!("非法 token: {e}"))?;
        headers.insert(header::AUTHORIZATION, value);
    }

    let mut builder = XetSessionBuilder::new();
    if let Some(dir) = &args.cache_dir {
        builder = builder.with_cache_dir(dir);
    }
    let session = builder.build().map_err(|e| format!("初始化 Xet 失败: {e}"))?;

    let file_info = match &args.sha256 {
        Some(sha) if !sha.is_empty() => {
            XetFileInfo::new_with_sha256(args.xet_hash.clone(), args.file_size, sha.clone())
        }
        _ => XetFileInfo::new(args.xet_hash.clone(), args.file_size),
    };

    // 续传走流式接口：Xet 的流式下载是严格顺序落盘（SequentialWriter 队列），文件长度
    // 永远是有效前缀，所以能反复续；而 download_file_to_path 是多连接随机偏移写，中途被杀
    // 之后文件长度可能是「空洞 + 未到达段」，不能当有效前缀。因此只要开了 --resume，
    // 哪怕本轮从 0 开始也走这条路径，保证第一次下载过程中的每个对齐点都能被续上。
    if args.resume {
        return run_resume(args, &session, file_info, headers, total, resume_from, &xet_config);
    }

    let group = session
        .new_file_download_group()
        .map_err(|e| format!("创建下载组失败: {e}"))?
        .with_token_refresh_url(args.token_refresh_url.clone(), headers)
        .build_blocking()
        .map_err(|e| format!("Xet 会话认证失败: {e}"))?;

    emit(&format!(
        "{{\"type\":\"start\",\"total\":{total},\"bytes\":0,\"resumeFrom\":0,\"pid\":{},\"xetConfig\":\"{}\"}}",
        std::process::id(),
        json_escape(&xet_config)
    ));

    let started = Instant::now();
    let handle = group
        .download_file_to_path_blocking(file_info, args.dest.clone())
        .map_err(|e| format!("启动下载失败: {e}"))?;

    // hf-xet 只有在调用过 finish() 之后才会把任务状态置为完成（在那之前 result() 永远是
    // None，靠轮询 result() 会一直等不到），所以主线程直接阻塞在 finish_blocking()，
    // 另起一个线程轮询并打印进度。
    //
    // 进度来源：hf-xet 的「下载到文件」是随机偏移写入（多连接并行），上游只对*流式*下载上报
    // 增量进度，handle.progress() 经常是 0 或一次跳几十 MB。这里改用落盘量：已分配块数
    // （st_blocks ≈ 已收到的字节数，未到达的空洞不占块）与文件长度取较大者，上限夹到文件大小。

    let interval = args.progress_interval;
    let stop = Arc::new(AtomicBool::new(false));
    let last_shown = Arc::new(AtomicU64::new(u64::MAX));
    let reporter = {
        let stop = Arc::clone(&stop);
        let last_shown = Arc::clone(&last_shown);
        let dest = args.dest.clone();
        let handle = handle.clone();
        std::thread::spawn(move || loop {
            let md = std::fs::metadata(&dest).ok();
            let apparent = md.as_ref().map(|m| m.len()).unwrap_or(0);
            let allocated = md.as_ref().map(allocated_bytes).unwrap_or(0);
            let item = handle.progress().map(|p| p.bytes_completed).unwrap_or(0);
            let mut shown = allocated.max(item);
            if apparent > 0 && shown > apparent {
                shown = apparent;
            }
            if total > 0 && shown > total {
                shown = total;
            }
            let elapsed_ms = started.elapsed().as_millis();

            if shown != last_shown.swap(shown, Ordering::SeqCst) {
                emit(&format!(
                    "{{\"type\":\"progress\",\"bytes\":{},\"total\":{},\"elapsedMs\":{},\"allocated\":{},\"written\":{}}}",
                    shown, total, elapsed_ms, allocated, apparent
                ));
            } else {
                // 心跳：Xet 按数据块批量落盘，两次进度之间可能十几秒没有变化；持续上报
                // 让调用方知道子进程还活着（只是在等下一批数据块），别把它当成卡死。
                emit(&format!(
                    "{{\"type\":\"heartbeat\",\"bytes\":{},\"total\":{},\"elapsedMs\":{},\"allocated\":{},\"written\":{}}}",
                    shown, total, elapsed_ms, allocated, apparent
                ));
            }

            if stop.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(interval);
        })
    };

    let report = handle.finish_blocking().map_err(|e| format!("下载失败: {e}"));
    stop.store(true, Ordering::SeqCst);
    let _ = reporter.join();
    let report = report?;

    let group_report = group
        .finish_blocking()
        .map_err(|e| format!("收尾失败: {e}"))?;

    let on_disk = std::fs::metadata(&args.dest).map(|m| m.len()).unwrap_or(0);
    let completed = report
        .progress
        .as_ref()
        .map(|p| p.bytes_completed)
        .unwrap_or_else(|| {
            handle
                .progress()
                .map(|p| p.bytes_completed)
                .unwrap_or(on_disk)
        });

    if total > 0 && on_disk != total {
        return Err(format!(
            "大小不一致（期望 {total}，实际 {on_disk}，Xet 报告 {completed}）"
        ));
    }

    emit(&format!(
        "{{\"type\":\"done\",\"bytes\":{},\"onDisk\":{},\"elapsedMs\":{},\"xetBytes\":{}}}",
        completed,
        on_disk,
        started.elapsed().as_millis(),
        group_report.progress.total_bytes_completed,
    ));
    Ok(())
}

/// 续传路径：打开已有前缀 -> 截断到对齐起点 -> Xet 流式 range 下载 -> 顺序追加落盘。
///
/// 关键点：
/// - `download_stream_blocking(hash, Some(start..total))` 的下游是 SequentialWriter 的
///   顺序队列，`blocking_next()` 出来的分片严格递增，所以文件长度始终等于「已校验前缀」。
/// - Xet 的 range 重建只用 merkle hash + file_size，sha256 不参与下载期校验，因此中途续传
///   不会因为哈希报错；但正因为它不校验，续传完成后必须自己整体 sha256 兜底。
/// 「已落盘字节数」的近似值：unix 用 st_blocks × 512（未到达的空洞不占块，正好反映已收到的量）；
/// Windows 没有对应字段，退回文件表观长度（此时进度显示偏乐观，但不会误判卡死）。
#[cfg(unix)]
fn allocated_bytes(md: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    (md.blocks() as u64) * 512
}

#[cfg(not(unix))]
fn allocated_bytes(md: &std::fs::Metadata) -> u64 {
    md.len()
}

/// - 中途中断（网络错 / 被 SIGKILL）时前缀依然有效：不删文件、状态文件留着，下次接着下。
///   只有长度不符或 sha256 不匹配才标记 corrupt，让调用方删掉半成品。
fn run_resume(
    args: &Args,
    session: &XetSession,
    file_info: XetFileInfo,
    headers: HeaderMap,
    total: u64,
    start: u64,
    xet_config: &str,
) -> Result<(), String> {
    let group = session
        .new_download_stream_group()
        .map_err(|e| format!("创建流式下载组失败: {e}"))?
        .with_token_refresh_url(args.token_refresh_url.clone(), headers)
        .build_blocking()
        .map_err(|e| format!("Xet 会话认证失败: {e}"))?;

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&args.dest)
        .map_err(|e| format!("打开目标文件失败: {e}"))?;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len != start {
        file.set_len(start).map_err(|e| format!("截断文件失败: {e}"))?;
    }
    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("定位续传起点失败: {e}"))?;

    let mut stream = group
        .download_stream_blocking(file_info, Some(start..total))
        .map_err(|e| format!("启动续传下载失败: {e}"))?;

    emit(&format!(
        "{{\"type\":\"start\",\"total\":{total},\"bytes\":{start},\"resumeFrom\":{start},\"pid\":{},\"xetConfig\":\"{}\"}}",
        std::process::id(),
        json_escape(xet_config)
    ));
    write_meta(args, start);

    let interval = args.progress_interval;
    let started = Instant::now();
    let done = Arc::new(AtomicU64::new(start));
    let stop = Arc::new(AtomicBool::new(false));
    let last_shown = Arc::new(AtomicU64::new(u64::MAX));
    let reporter = {
        let stop = Arc::clone(&stop);
        let done = Arc::clone(&done);
        let last_shown = Arc::clone(&last_shown);
        let interval = interval;
        std::thread::spawn(move || loop {
            let shown = done.load(Ordering::SeqCst).min(total);
            let elapsed_ms = started.elapsed().as_millis();
            if shown != last_shown.swap(shown, Ordering::SeqCst) {
                emit(&format!(
                    "{{\"type\":\"progress\",\"bytes\":{shown},\"total\":{total},\"elapsedMs\":{elapsed_ms},\"written\":{shown},\"resumeFrom\":{start}}}"
                ));
            } else {
                // 心跳：分片是一批批到的，两次进度之间可能十几秒没变化，持续上报免得被当卡死
                emit(&format!(
                    "{{\"type\":\"heartbeat\",\"bytes\":{shown},\"total\":{total},\"elapsedMs\":{elapsed_ms},\"written\":{shown},\"resumeFrom\":{start}}}"
                ));
            }
            if stop.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(interval);
        })
    };

    stream.start();
    let mut written: u64 = 0;
    let mut next_meta = META_INTERVAL;
    let mut stream_error: Option<String> = None;
    loop {
        match stream.blocking_next() {
            Ok(Some(chunk)) => {
                let n = chunk.len() as u64;
                if let Err(e) = file.write_all(&chunk) {
                    stream_error = Some(format!("写入失败: {e}"));
                    break;
                }
                written += n;
                done.store(start + written, Ordering::SeqCst);
                if written >= next_meta {
                    next_meta += META_INTERVAL;
                    write_meta(args, (start + written).min(total));
                }
            }
            Ok(None) => break,
            Err(e) => {
                stream.cancel();
                stream_error = Some(format!("下载失败: {e}"));
                break;
            }
        }
    }

    let _ = file.flush();
    let _ = file.sync_all();
    stop.store(true, Ordering::SeqCst);
    let _ = reporter.join();

    if let Some(msg) = stream_error {
        // 前缀仍然有效：留着文件和状态文件，调用方重试时从这里接着下
        return Err(msg);
    }

    let on_disk = std::fs::metadata(&args.dest).map(|m| m.len()).unwrap_or(0);
    if total > 0 && on_disk != total {
        mark_corrupt();
        return Err(format!("大小不一致（期望 {total}，实际 {on_disk}）"));
    }

    group
        .finish_blocking()
        .map_err(|e| format!("收尾失败: {e}"))?;

    if let Some(expected) = args.sha256.as_deref() {
        if !expected.is_empty() && std::env::var_os("XET_SKIP_SHA256_VERIFY").is_none() {
            let actual = sha256_hex_of_file(args, &started)?;
            if !actual.eq_ignore_ascii_case(expected) {
                mark_corrupt();
                return Err(format!("sha256 校验不通过（期望 {expected}，实际 {actual}）"));
            }
        }
    }

    remove_meta(args);
    emit(&format!(
        "{{\"type\":\"done\",\"bytes\":{total},\"onDisk\":{on_disk},\"elapsedMs\":{},\"resumeFrom\":{start}}}",
        started.elapsed().as_millis()
    ));
    Ok(())
}

/// 整体 sha256（续传后必须做一次，因为 Xet 的 range 重建不校验 sha256）。
/// 校验期间也定时上报 verifying，免得调用方以为停滞把任务掐掉。
fn sha256_hex_of_file(args: &Args, started: &Instant) -> Result<String, String> {
    use sha2::{Digest, Sha256};

    let mut file = std::fs::File::open(&args.dest).map_err(|e| format!("打开文件失败（校验）: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 8 * 1024 * 1024];
    let mut verified: u64 = 0;
    let mut last_emit = Instant::now();
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("读取失败（校验）: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        verified += n as u64;
        if last_emit.elapsed() >= args.progress_interval {
            last_emit = Instant::now();
            emit(&format!(
                "{{\"type\":\"verifying\",\"verified\":{verified},\"total\":{},\"elapsedMs\":{}}}",
                args.file_size,
                started.elapsed().as_millis()
            ));
        }
    }
    let out = hasher.finalize();
    Ok(out.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

fn main() {
    let args = parse_args();
    match run(&args) {
        Ok(()) => std::process::exit(0),
        Err(msg) => {
            emit_error(&msg);
            std::process::exit(1);
        }
    }
}
