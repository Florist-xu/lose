#!/bin/sh
# 安装抖音解析服务 media-parser 到 ~/media-parser(只需运行一次)
# Termux 上 mini-racer 无法编译:跳过它。抖音走"分享页"解析,不依赖它。
set -e
D="$HOME/media-parser"
PY=$(command -v python3 || command -v python) || { echo "未找到 python"; exit 1; }
if command -v pkg >/dev/null 2>&1; then
  pkg install -y git clang make pkg-config libxml2 libxslt libffi openssl
fi
[ -d "$D" ] || git clone --depth 1 https://github.com/ucmao/media-parser.git "$D"
cd "$D"
grep -vi 'mini-racer' requirements.txt > requirements.nomr.txt
"$PY" -m pip install -r requirements.nomr.txt
"$PY" -m pip install mini-racer >/dev/null 2>&1 && echo "mini-racer 已安装" || echo "mini-racer 装不上,使用替身(不影响抖音解析)"
echo "完成。之后直接 sh start.sh 即可,会自动启动解析服务。"
