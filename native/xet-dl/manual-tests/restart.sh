#!/bin/bash
PID=$(ss -ltnp 2>/dev/null | grep ':2270' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
if [ -n "$PID" ]; then kill "$PID"; sleep 2; fi
kill -9 "$PID" 2>/dev/null
cd "$HOME/Documents/hf" || exit 1
setsid nohup pnpm start </dev/null >> /home/cqwuxiaolong/hf-server-2270.log 2>&1 &
sleep 4
ss -ltnp 2>/dev/null | grep ':2270'
