#!/bin/sh
# Termux / Linux / macOS 一键启动(仅需 python3,默认端口 6060)
# 若已运行过 sh parser-setup.sh,会自动在后台启动抖音解析服务(127.0.0.1:8051)
cd "$(dirname "$0")" || exit 1
PY=$(command -v python3 || command -v python) || { echo "未找到 python,请执行: pkg install -y python"; exit 1; }
if [ -z "$PARSER_URL" ] && [ -d "$HOME/media-parser" ]; then
  sh ./parser-run.sh > "$HOME/media-parser/run.log" 2>&1 &
  PARSER_PID=$!
  trap 'kill $PARSER_PID 2>/dev/null' EXIT INT TERM
  export PARSER_URL=http://127.0.0.1:8051
  echo "已启动抖音解析服务(日志: ~/media-parser/run.log)"
fi
"$PY" server.py
