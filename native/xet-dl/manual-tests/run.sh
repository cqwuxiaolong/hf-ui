#!/bin/bash
# Xet 真续传验证：全程 SIGKILL，测试文件本机从未下载过（Qwen/Qwen3-0.6B model.safetensors 1.5GB）
set -u
D=$(cd "$(dirname "$0")" && pwd)/scratch
HASH=6f87d3bff66602a9611e541180dec950a6b6a9068ca274ee43ac8f83550f0223
SIZE=1503300328
SHA=f47f71177f32bcd101b7573ec9171e6a57f4f4d31148d38e382306f42996874b
URL="https://hf-mirror.com/api/models/Qwen/Qwen3-0.6B/xet-read-token/main"
BIN=$HOME/Documents/hf/native/bin/xet-dl
F=$D/model.safetensors
mkdir -p "$D"
sz() { stat -c %s "$F" 2>/dev/null || echo 0; }
CHILD=""
start() {
  XET_MEMORY_BUDGET_MB=1024 "$BIN" --xet-hash "$HASH" --file-size "$SIZE" --dest "$F" \
    --token-refresh-url "$URL" --sha256 "$SHA" --progress-interval-ms 1000 \
    --resume --meta "$D/state.json" > "$D/$1.ndjson" 2> "$D/$1.err" &
  CHILD=$!
  echo "  pid=$CHILD"
}
wait_for() {
  local target=$1 limit=$2 t=0 s
  while [ "$t" -lt "$limit" ]; do
    s=$(sz); [ "$s" -ge "$target" ] && { echo "  到达 $s 字节（${t}s）"; return 0; }
    if ! kill -0 "$CHILD" 2>/dev/null; then
      echo "  !! 子进程提前退出，当前 $s 字节"; echo "  ---- stderr ----"; sed 's/^/    /' "$D"/*.err | tail -10; return 2
    fi
    sleep 1; t=$((t+1))
  done
  echo "  等待超时，当前 $s 字节"; return 1
}
showstart() { echo "  start: $(grep -m1 '"type":"start"' "$D/$1.ndjson")"; }

echo "### round1: 全新下载，400MB 时 SIGKILL"
start run1; sleep 5; showstart run1
wait_for 400000000 600
kill -9 "$CHILD" 2>/dev/null; wait "$CHILD" 2>/dev/null
echo "  杀死时长度=$(sz)"; echo "  state.json: $(cat "$D/state.json" 2>/dev/null)"
sleep 1

echo "### round2: 续传，900MB 时再 SIGKILL"
start run2; sleep 6; showstart run2
echo "  续传起点长度=$(sz)"
wait_for 900000000 600
kill -9 "$CHILD" 2>/dev/null; wait "$CHILD" 2>/dev/null
echo "  杀死时长度=$(sz)"; echo "  state.json: $(cat "$D/state.json" 2>/dev/null)"
sleep 1

echo "### round3: 续传到完成 + 整体 sha256"
start run3; sleep 6; showstart run3
while kill -0 "$CHILD" 2>/dev/null; do sleep 3; done
wait "$CHILD"; RC=$?
echo "  退出码=$RC"
echo "  最终长度=$(sz)  期望=$SIZE"
echo "  消息尾部:"; tail -3 "$D/run3.ndjson" | sed 's/^/    /'
echo "  stderr:"; sed 's/^/    /' "$D/run3.err" | tail -5
echo "  state.json（应已删除）: $(ls "$D/state.json" 2>&1)"
echo "  实际 sha256: $(sha256sum "$F" | cut -d' ' -f1)"
echo "  期望 sha256: $SHA"
echo "### DONE"
