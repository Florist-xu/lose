# 跟练打卡:5 组 × 4 动作 × 20 次(摄像头识别)

摄像头姿态识别(MediaPipe)+ 计数 + 计时,每个动作满 20 次自动切换下一动作/下一组,并播放视频里提取的音频。
训练结束后可**保存或放弃**当天记录;每组会**随机抓拍一张**照片;记录存入 **SQLite**。

## 在 Termux 启动
```bash
pkg update && pkg upgrade -y
pkg install -y git python openssl-tool
git clone https://github.com/Florist-xu/lose.git
cd lose
sh start.sh
```
然后在手机浏览器打开 `http://localhost:6060`,允许摄像头权限(localhost 才能用摄像头)。
更新:`cd ~/lose && git pull`。

> 服务器只依赖 Python 标准库(含 sqlite3),不需要 node。

### 让别的设备(如 iPhone)访问
摄像头要求 HTTPS,先生成证书再启动:
```bash
sh gen-cert.sh 本机的局域网IP     # 例如 sh gen-cert.sh 192.168.1.8
sh start.sh
```
然后在另一台设备打开 `https://本机的局域网IP:6061`,首次点"继续访问"。

### 端口
默认 HTTP **6060**、HTTPS **6061**;可修改:`PORT=7000 SPORT=7001 sh start.sh`。

## Windows 启动
双击 `start.bat`(需要已安装 Python)。

## 中场休息与休息音乐
- 每组(4 个动作)结束后**中场休息 2 分钟**再开始下一组;组内动作之间仍是 10 秒休息。休息界面可"跳过休息""暂停/播放音乐""下一首"。
- 页头"休息音乐":
  - **上传音频/视频文件**(mp3 / m4a / aac / wav / ogg / flac / mp4,单个 ≤ 60MB;mp4 视频只播放声音)。
  - **粘贴音频直链**(直接指向音频文件的 http(s) 地址)导入。
  - 选择"全部随机"或指定某一首;可试听、删除。
- **抖音分享链接解析(可选)**:本项目不内置解析器。如需粘贴抖音分享文字直接导入,请另外运行开源项目 [media-parser](https://github.com/ucmao/media-parser)(MIT;作者已声明可能在 2026-12-01 后删除大部分平台解析代码,建议尽早 fork 备份),然后启动本服务时指定它的地址:
  - **Termux / Linux 一键方式**:先运行一次 `sh parser-setup.sh`(自动下载 media-parser;Termux 上 mini-racer 装不上会自动用替身,抖音仍可解析),之后每次 `sh start.sh` 会自动在后台启动它并设置 `PARSER_URL`。
  - **手动方式**:自己启动 media-parser 后 `PARSER_URL=http://127.0.0.1:8051 sh start.sh`(需 Python 3.10+;Windows 还要补 `fcntl` 和 `tzdata`)。
  - 它默认监听 `0.0.0.0`,脚本已改为只监听 127.0.0.1。
  未配置 `PARSER_URL` 时,请在抖音里"保存视频"到手机,再用"上传"选择该文件。解析依赖平台接口,随时可能失效。
- 音乐文件保存在 `data/music/`(不会上传到 GitHub,避免版权问题),列表存在 SQLite 的 `music` 表。

## 用户
- 首次打开会弹出登录框,**只需输入用户名**(字母/数字/汉字/_ . -,1~20 个字符,不区分大小写),无需密码;右上角"👤 用户名"可切换用户。
- 训练记录、历史记录按用户名分开保存。升级前已有的全部记录自动归到用户 **florist**。
- 休息音乐是所有用户共用的。
- ⚠️ 没有密码,只适合自己的手机/家庭局域网;知道用户名的人就能看到那个用户的记录。

## 训练记录
- 点"结束训练"或 5 组全部完成后,会弹出保存提示:**保存记录 / 放弃保存**。
- 记录内容:日期、总用时(含休息)、动作用时、完成动作数、每个动作的次数与用时、每组随机抓拍的一张图。
- 抓拍规则:每组随机挑一个动作、在动作开始后的随机时刻拍一张;跳过/提前结束时会兜底补拍。
- 右上角"历史记录":按天汇总锻炼时长,点开可看每次训练和图片,也可删除。
- 数据保存在 `data/workout.db`(SQLite,已加入 .gitignore,不会上传)。备份只需复制这个文件。
  可用环境变量 `DB_PATH` 改位置。

### 接口(供参考)
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/sessions` | 保存一次训练(含 `user`、base64 JPEG 图片) |
| GET | `/api/users` | 已有用户列表 |
| GET | `/api/days?user=名字` | 按天汇总 |
| GET | `/api/sessions?day=YYYY-MM-DD&user=名字` | 某天的训练列表 |
| GET | `/api/images/<id>` | 图片 |
| DELETE | `/api/sessions/<id>?user=名字` | 删除一条(连同图片,只能删自己的) |
| GET / PUT | `/api/music` | 音乐列表 / 上传(原始文件作为请求体,`?name=文件名`) |
| POST | `/api/music/link` | 导入音频直链 `{url}`(禁止访问内网地址) |
| DELETE | `/api/music/<id>` | 删除音乐 |

> 注意:接口没有登录验证,仅适合在自己的手机/家庭局域网使用,不要暴露到公网。

## 文件
- `workouts/<id>/`:每个运动项目一个文件夹(配置+模板+音频+示范视频),页头"项目"下拉框切换;新增方法见 [workouts/README.md](workouts/README.md)
- `workouts/fatburn/workout.json`:当前项目的 20 个动作时间段与识别模板(由参考视频提取)
- `build_templates.py`:fatburn 的模板生成脚本(需要 `pose_raw.json`,未提交)
- `app.js` / `index.html`:前端识别、流程、保存与历史
- `server.py`:服务器(静态文件白名单 + Range + SQLite 接口);`start.sh` / `start.bat` 启动脚本
- `lib/`:本地 MediaPipe 库与姿态模型(离线可用)
- `workouts/fatburn/workout.m4a`:从原视频提取的音频,按当前动作的片段循环播放;`workout.mp4` 是示范画面(可选)

## 常见问题
- **`CANNOT LINK EXECUTABLE "node"`**:本项目已不使用 node,直接 `sh start.sh` 即可。
