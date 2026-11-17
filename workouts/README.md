# 运动项目(workouts)

每个运动项目是 `workouts/` 下的一个文件夹,页头"项目"下拉框会自动列出它们,**新增项目不需要改代码**:

```
workouts/
  fatburn/              # 文件夹名 = 项目 id(只能用字母、数字、_ -)
    workout.json        # 项目配置 + 动作片段 + 识别模板(必需)
    workout.m4a         # 从原视频提取的背景音频(必需)
    workout.mp4         # 示范画面(可选,没有也能用)
  situp/                # 例如以后加"卷腹"
    ...
```

## 新增一个运动(例如卷腹)的步骤
1. 把原视频放进 `E:\lose`(与 `ffmpeg.exe` 同目录,不要提交到 git),告诉我动作的名称、组数、每组几个动作、每个动作的次数。
2. 我会从视频里:切分每个动作的时间段 → 提取音频 `workout.m4a`、缩略示范 `workout.mp4` → 生成 `workout.json`。
3. 卷腹这类**识别方式不同**的动作,还需要在 `app.js` 里加一种"计数器"(比如用躯干倾角计数,而不是现在的抬膝计数)。
4. 把生成好的文件夹放进 `workouts/<id>/`,`git push`,手机上 `git pull` 后刷新页面就能在下拉框里切换。

## workout.json 字段
| 字段 | 说明 |
|---|---|
| `id` / `name` / `desc` | 项目 id(与文件夹同名)、显示名称、说明 |
| `groups` | 共几组 |
| `movesPerGroup` | 每组几个动作(`templates` 的长度与之相同) |
| `reps` | 每个动作做几次 |
| `restSec` / `groupRestSec` | 动作之间的休息 / 每组结束后的中场休息(秒) |
| `counter` | 计数方式,目前只支持 `kneeLift`(抬膝);写别的会提示"暂未支持" |
| `audio` / `video` | 同目录下的音频、示范视频文件名 |
| `segments` | 每个动作在视频里的 `start` / `end` 秒,共 `groups × movesPerGroup` 项,按 组→动作 顺序 |
| `templates` | 每个动作的识别模板(`name`、`mean`、`std`,可选权重 `w`) |

## 训练记录
记录里会保存项目 id 和名称,"历史记录"里每次训练会显示它属于哪个项目。旧记录自动归为 `fatburn`。
