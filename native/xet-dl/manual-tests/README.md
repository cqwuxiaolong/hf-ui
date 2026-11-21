# xet-dl 手工回归脚本

不经界面，直接验 `native/bin/xet-dl` 的真续传与服务端到端行为。
两个脚本都用 **Qwen/Qwen3-0.6B 的 model.safetensors（1.5 GB）**：这台机器从未下过它，
不会拿已经下好的模型自欺欺人；跑完自己删测试文件。

| 脚本 | 作用 |
| --- | --- |
| `go.sh` | 先清空 `scratch/` 再跑 `run.sh`（保证是「本机没下过的全新文件」，不会拿上一轮的半成品糊过去）。 |
| `run.sh` | 二进制级：全新下载 → `SIGKILL` → `--resume` → 再 `SIGKILL` → 再续到完成，最后比对工具自带 sha256，并确认续传状态文件已被删除。日志落在 `out.log`。 |
| `e2e.sh` | 服务端到端（需 2270 在跑）：建任务 → 暂停（确认 `<文件>.xet-partial` 保留且不再增长）→ 继续（确认从上次的字节接着，不是 0）→ 完成后 `sha256sum` 比对 → 删任务与文件 → 再往 `dest` 塞 200 MB 半成品，验证 fetch 前缀播种（改名当种子续传）。日志落在 `e2e.log`。 |
| `restart.sh` | 重启 2270 服务（改过 `server/*.js` 后用）。 |

```bash
bash go.sh > out.log 2>&1               # 二进制级 3 轮 SIGKILL，约 4 分钟
bash restart.sh && bash e2e.sh > e2e.log 2>&1   # 服务端到端，约 4 分钟
```

`scratch/` 只是临时目录，跑完随手删。
