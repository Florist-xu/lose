#!/bin/sh
# Termux / Linux / macOS 一键启动(仅需 python3,默认端口 6060)
cd "$(dirname "$0")" || exit 1
PY=$(command -v python3 || command -v python) || { echo "未找到 python,请执行: pkg install -y python"; exit 1; }
exec "$PY" server.py
