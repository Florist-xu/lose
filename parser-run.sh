#!/bin/sh
# 在本机 127.0.0.1:8051 启动 media-parser(由 start.sh 调用)
D="$HOME/media-parser"
PY=$(command -v python3 || command -v python) || exit 1
cd "$D" || exit 1
if ! "$PY" -c "import py_mini_racer" 2>/dev/null; then
  mkdir -p stub/py_mini_racer
  : > stub/py_mini_racer/__init__.py
  printf 'class MiniRacer:\n    def eval(self, *a, **k): return None\n    def call(self, *a, **k): raise RuntimeError("mini-racer unavailable")\n' > stub/py_mini_racer/_mini_racer.py
  export PYTHONPATH="$D/stub"
fi
API_ONLY=1 exec "$PY" -c "import app; app.app.run(host='127.0.0.1', port=8051)"
