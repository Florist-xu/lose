#!/bin/sh
# 安装本机网易云接口 netease-api(只需运行一次;更新后可重复运行)
# 前提:已把你的 netease-api 仓库 clone 到 ~/netease-api
set -e
D="$HOME/netease-api"
if ! command -v node >/dev/null 2>&1; then
  if command -v pkg >/dev/null 2>&1; then pkg install -y nodejs-lts; else echo "请先安装 Node.js 22+"; exit 1; fi
fi
echo "Node 版本: $(node -v)"
[ -d "$D" ] || { echo "没找到 $D,请先: git clone https://github.com/Florist-xu/netease-api.git ~/netease-api"; exit 1; }
cd "$D"
# 国内 npm 镜像,下载更快
npm config get registry | grep -q npmmirror || npm config set registry https://registry.npmmirror.com
# --ignore-scripts:跳过 husky 等开发用的安装钩子(手机上用不到)
npm install --omit=dev --ignore-scripts --no-audit --no-fund
echo "完成。之后直接 sh start.sh,会自动在后台启动本机网易云接口(127.0.0.1:3000)。"
