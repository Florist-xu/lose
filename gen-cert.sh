#!/bin/sh
# 用法: sh gen-cert.sh 192.168.22.75   (参数为本机局域网 IP)
# Termux 需先: pkg install openssl-tool
IP=${1:?请传入本机局域网IP,例如 sh gen-cert.sh 192.168.1.8}
export MSYS_NO_PATHCONV=1
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=$IP" -addext "subjectAltName=IP:$IP,DNS:localhost" && echo "证书已生成到 certs/"
