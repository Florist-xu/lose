#!/bin/sh
# Termux / Linux / macOS 一键启动:优先 node,node 不可用则自动改用 python
cd "$(dirname "$0")" || exit 1
if node -e "0" >/dev/null 2>&1; then
  exec node server.js
elif command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then
  echo "node 不可用,改用 Python 服务器"
  exec "$(command -v python3 || command -v python)" server.py
else
  echo "未找到可用的 node 或 python。请执行: pkg upgrade -y && pkg install -y python"
  exit 1
fi
