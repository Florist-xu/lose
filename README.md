# 跟练打卡:5 组 × 4 动作 × 20 次(摄像头识别)

摄像头姿态识别(MediaPipe)+ 计数 + 计时,每个动作满 20 次自动切换下一动作/下一组,并播放示范视频的音频。

## 在 Termux 启动
```bash
pkg update && pkg install -y nodejs git
git clone https://github.com/Florist-xu/lose.git
cd lose
node server.js
```
然后在手机浏览器打开 `http://localhost:8080`,允许摄像头权限(localhost 才能用摄像头)。

## Windows 启动
双击 `start.bat`。

## 文件
- `templates.json`:20 个动作的时间段与识别模板(由参考视频提取)
- `build_templates.py`:模板生成脚本(需要 `pose_raw.json`,未提交)
- `app.js` / `index.html`:前端识别与流程
- `lib/`:本地 MediaPipe 库与姿态模型(离线可用)
- `media/workout.mp4`:压缩后的示范视频(含音频)
