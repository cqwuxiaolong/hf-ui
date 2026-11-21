#!/bin/bash
# 服务端到端：下载 → 暂停 → 继续（真续传）→ 完成校验 → 清理 → fetch 前缀播种
set -u
API=http://127.0.0.1:2270
REPO=Qwen/Qwen3-0.6B
FILE=model.safetensors
SHA=f47f71177f32bcd101b7573ec9171e6a57f4f4d31148d38e382306f42996874b
REF=$(cd "$(dirname "$0")" && pwd)/scratch/model.safetensors
DEST=$HOME/Documents/basalt/models/Qwen/Qwen3-0.6B/model.safetensors
TMP="$DEST.xet-partial"

snap() { curl -s -m 8 "$API/api/tasks" | python3 -c '
import sys,json
d=json.load(sys.stdin)
for t in d.get("tasks",[]):
    print("%s|%s|%s|%s|ver=%s|engine=%s" % (t["id"],t["status"],t.get("downloaded"),t.get("size"),t.get("verifying"),t.get("engine")))
'; }
tid() { snap | head -1 | cut -d'|' -f1; }
fld() { snap | head -1 | cut -d'|' -f"$1"; }

echo "### 1) 新建任务（本机从未下过 $REPO/$FILE）"
curl -s -m 15 -X POST "$API/api/tasks" -H 'Content-Type: application/json' \
  -d "{\"repo\":\"$REPO\",\"file\":\"$FILE\"}" | head -c 300; echo
ID=$(tid); echo "  id=$ID"

echo "### 2) 跑到 300MB 以上后暂停"
for i in $(seq 1 180); do
  s=$(snap | head -1); st=$(echo "$s" | cut -d'|' -f2); dl=$(echo "$s" | cut -d'|' -f3)
  dl=${dl:-0}
  if [ "$dl" -ge 300000000 ]; then echo "  已达 $dl 字节（${i}s），暂停"; break; fi
  if [ "$st" = error ] || [ "$st" = done ]; then echo "  提前结束: $s"; break; fi
  sleep 1
done
P1=$(stat -c %s "$TMP" 2>/dev/null || echo 0)
curl -s -m 8 -X POST "$API/api/tasks/$ID/pause" > /dev/null; sleep 2
P2=$(stat -c %s "$TMP" 2>/dev/null || echo 0)
echo "  暂停后 tmp 长度=$P2（暂停前 $P1）"
sleep 6
P3=$(stat -c %s "$TMP" 2>/dev/null || echo 0)
echo "  暂停 6s 后 tmp 长度=$P3（应与 $P2 相同）"
echo "  state.json: $(cat ~/.cache/hf-web-manager/xet-state/*.json 2>/dev/null | head -c 200)"
SN=$(snap | head -1); echo "  暂停后任务: $SN"
BEFORE=$P3

echo "### 3) 继续（应从上次的字节接着）"
curl -s -m 8 -X POST "$API/api/tasks/$ID/resume" > /dev/null; sleep 8
SN=$(snap | head -1); echo "  继续后 8s: $SN"
DL=$(echo "$SN" | cut -d'|' -f3); DL=${DL:-0}
P4=$(stat -c %s "$TMP" 2>/dev/null || echo 0)
echo "  继续后 tmp 长度=$P4（续传前 $BEFORE，应 >= 且不是从头）"
if [ "$DL" -ge "$BEFORE" ] && [ "$DL" -gt 0 ]; then echo "  ✅ 续传起点 > 0 且未回退"; else echo "  ❌ 疑似从头下载"; fi

echo "### 4) 等完成（含整体 sha256 校验）"
for i in $(seq 1 420); do
  s=$(snap | head -1); st=$(echo "$s" | cut -d'|' -f2)
  case "$st" in done|error|canceled) echo "  结束: $s（${i}s）"; break;; esac
  sleep 2
done
echo "  最终任务: $(snap | head -1)"
echo "  实际 sha256: $(sha256sum "$DEST" 2>/dev/null | cut -d' ' -f1)"
echo "  期望 sha256: $SHA"
echo "  state 目录: $(ls -l ~/.cache/hf-web-manager/xet-state/ 2>&1 | tail -3)"
echo "  tmp 应已消失: $(ls -l "$TMP" 2>&1 | tail -1)"

echo "### 5) 删除任务与文件（先留出 200MB 前缀给第 6 步当种子）"
mkdir -p "$(dirname "$REF")"
head -c 200000000 "$DEST" > "$REF" 2>/dev/null || echo "  （取种子失败，第 6 步会跳过）"
curl -s -m 10 -X DELETE "$API/api/tasks/$ID?deleteFile=1" | head -c 120; echo
echo "  清理后: $(ls -l "$DEST" 2>&1 | tail -1)"
sleep 2
echo "  任务列表: $(snap)"

echo "### 6) fetch 前缀播种：dest 先放 200MB 半成品，再新建任务"
mkdir -p "$(dirname "$DEST")"
head -c 200000000 "$REF" > "$DEST"
echo "  预置 dest = $(stat -c %s "$DEST") 字节"
curl -s -m 15 -X POST "$API/api/tasks" -H 'Content-Type: application/json' \
  -d "{\"repo\":\"$REPO\",\"file\":\"$FILE\"}" > /dev/null
sleep 12
SN=$(snap | head -1); echo "  播种后任务: $SN"
DL=$(echo "$SN" | cut -d'|' -f3); DL=${DL:-0}
if [ "$DL" -ge 190000000 ]; then echo "  ✅ 从预置前缀续传（$DL）"; else echo "  ❌ 未用播种前缀（$DL）"; fi
echo "  tmp = $(stat -c %s "$TMP" 2>/dev/null || echo 无)  dest = $(stat -c %s "$DEST" 2>/dev/null || echo 已改名)"

echo "### 7) 取消并清理"
ID2=$(tid); curl -s -m 8 -X POST "$API/api/tasks/$ID2/cancel" > /dev/null; sleep 2
curl -s -m 10 -X DELETE "$API/api/tasks/$ID2?deleteFile=1" | head -c 120; echo
echo "  剩余任务: $(snap)"
echo "  残留检查: $(find "$HOME/Documents/basalt/models/Qwen" -type f 2>/dev/null | head -5)"
echo "  state 残留: $(ls ~/.cache/hf-web-manager/xet-state/ 2>/dev/null | head -5)"
echo "### DONE"
