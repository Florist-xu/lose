# 跟练打卡:5 组 × 4 动作 × 20 次(摄像头识别)

摄像头姿态识别(MediaPipe)+ 计数 + 计时,每个动作满 20 次自动切换下一动作/下一组,并播放示范视频的音频。

## 在 Termux 启动
```bash
pkg update && pkg upgrade -y
pkg install -y git python openssl-tool
git clone https://github.com/Florist-xu/lose.git
cd lose
sh start.sh
```
`start.sh` 会优先用 node,node 不可用时自动改用 Python(`server.py`),功能完全一样。

然后在手机浏览器打开 `http://localhost:8080`,允许摄像头权限(localhost 才能用摄像头)。

### 常见问题
- **`CANNOT LINK EXECUTABLE "node"`**:Termux 的 nodejs 与系统库版本不匹配。先 `pkg upgrade -y`;仍不行就用 `start.sh`(自动走 Python),或 `pkg install nodejs-lts`。
- **想让别的设备(如 iPhone)访问**:摄像头要求 HTTPS,先生成证书再启动:
  ```bash
  sh gen-cert.sh 手机的局域网IP     # 例如 sh gen-cert.sh 192.168.1.8
  sh start.sh
  ```
  然后在另一台设备打开 `https://手机的局域网IP:8443`,首次点"继续访问"。
- **端口**:默认 HTTP 8080、HTTPS 8443;可用 `PORT=9000 SPORT=9443 sh start.sh` 修改。

## Windows 启动
双击 `start.bat`。

## 文件
- `templates.json`:20 个动作的时间段与识别模板(由参考视频提取)
- `build_templates.py`:模板生成脚本(需要 `pose_raw.json`,未提交)
- `app.js` / `index.html`:前端识别与流程
- `server.js` / `server.py`:静态服务器(node 版 / Python 备用版),`start.sh`、`start.bat` 为启动脚本
- `lib/`:本地 MediaPipe 库与姿态模型(离线可用)
- `media/workout.mp4`:压缩后的示范视频(含音频)
