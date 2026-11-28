#!/bin/sh
# Termux / Linux / macOS 一键启动(仅需 python3,默认端口 6060)
# 若已运行过 sh parser-setup.sh,会自动在后台启动抖音解析服务(127.0.0.1:8051)
# 若已运行过 sh ncm-setup.sh,会自动在后台启动本机网易云接口(127.0.0.1:3000),App 里的网易云功能会更快
cd "$(dirname "$0")" || exit 1
PY=$(command -v python3 || command -v python) || { echo "未找到 python,请执行: pkg install -y python"; exit 1; }
PIDS=""
trap 'kill $PIDS 2>/dev/null' EXIT INT TERM
if [ -z "$PARSER_URL" ] && [ -d "$HOME/media-parser" ]; then
  sh ./parser-run.sh > "$HOME/media-parser/run.log" 2>&1 &
  PIDS="$PIDS $!"
  export PARSER_URL=http://127.0.0.1:8051
  echo "已启动抖音解析服务(日志: ~/media-parser/run.log)"
fi
if [ -z "$NCM_LOCAL" ] && [ -d "$HOME/netease-api/node_modules" ] && command -v node >/dev/null 2>&1; then
  (cd "$HOME/netease-api" && HOST=127.0.0.1 PORT=3000 exec node app.js) > "$HOME/netease-api/run.log" 2>&1 &
  PIDS="$PIDS $!"
  export NCM_LOCAL=http://127.0.0.1:3000
  echo "已启动本机网易云接口(日志: ~/netease-api/run.log)"
fi
"$PY" server.py
