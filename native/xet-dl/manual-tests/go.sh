#!/bin/bash
# 清掉上次的 scratch 后重跑 run.sh（进度/日志仍写到本目录的 out.log）
set -u
T=$(cd "$(dirname "$0")" && pwd)
D="$T/scratch"
mkdir -p "$D"
find "$D" -maxdepth 1 -type f -delete
exec bash "$T/run.sh"
