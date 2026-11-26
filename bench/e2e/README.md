# 端到端自动化测试（不接眼镜）—— **备用**

> **先用真机向量回放：`bench/replay/`。** 它更真（真机真录的口音/噪声/停顿）、
> 更快、可反复跑、能逐段对比。只有两种情况回到这里：
> 1. 手上没有可用的历史录音（新装环境、刚清过档案）；
> 2. 要验**声学通路**本身（喇叭真的出声了吗、麦克风真的收音了吗）。
>
> E2E 的代价：每条用例要录一遍（20 s 起），素材是合成音，受房间噪声和音量影响，
> 而且延迟数字被"播放起播 + 采集缓冲"污染。

用**手机自己的喇叭和麦克风**把整条语音链路跑起来：云端 TTS 说一句 → 手机喇叭放出来
→ 空气 → 手机麦克风录下来 → 当上行 PCM 喂回云端 → ASR → agent → TTS → 手机喇叭播回复。

```
python bench/e2e/run.py                 # 默认 4 条话术（闲聊 / 鼓励 / 算数 / 问时间）
python bench/e2e/run.py --only 3        # 只跑第 3 条
```

跑完打印一张表（说完→首音 / dsh / TTS 首块 / 回复长度 / ASR 重叠率 / 通过与否），
明细在 `bench/e2e/out/summary.json`，每条的素材和录音在 `bench/e2e/out/<n>-<slug>/`。

## 为什么要这么绕

真机（眼镜）不在环路里时，唯一能同时验证「声学 + ASR + agent + TTS + 下行」的办法
就是让手机同时当喇叭和话筒。任何一环用文件代替（比如直接喂 TTS 的 PCM 当上行），
测出来的延迟就不作数了 —— 那等于跳过了真实的采集与播放。

## 两个坑（都踩过）

**屏幕必须亮。** Dozing 状态下 Android 会把录音轨静音（`setRecordSilenced`），
表现是 `peak=0`、ASR 一个字也认不出，很容易误诊成 ASR 问题。脚本每条用例前都会唤醒。

**麦克风不能用 `app_process` 录。** 录音权限检查走 `AttributionSource`（包名 + AppOps），
`app_process` 没有包身份 —— 拿 root 也一样被静音（实测 `uid:0, silenced 1`）。
所以有一个 37 行的最小 APK：`bench/e2e/mictap/`，首次运行时自动编译安装。

## 文件

| 文件 | 作用 |
|---|---|
| `run.py` | 编排：合成 → 播 + 录 → 上行 → 播回复 → 断言 → 汇总 |
| `../replay/client.mjs` | 线协议客户端（与向量回放共用） |
| `synth.mjs` | 在**服务器上**跑，用线上同一条 CosyVoice 合成"用户说的话" |
| `mictap/` | 最小录音 APK（`build.py` 用 aapt2 + d8 + apksigner，不需要 Gradle） |

## 前置条件

- `adb devices` 里有一台真机（脚本自己取第一台）
- 能 ssh 到云端（`~/.ssh/<私钥>`），服务器上 `.env` 齐备
- 手机媒体音量调高（`adb shell cmd media_session volume --stream 3 --set 15`）
- 手机装了 `miai.jar`：`在 Miaiglassses2grokbot 仓执行 python scripts/ci/build_android.py --push`（喇叭播放走它）

## 量什么

| 指标 | 口径 |
|---|---|
| **说完→首音** | 客户端侧：最后一个"有声块"送出去 → 收到第一个下行音频字节 |
| **dsh** | 服务端档案 `turn.end.dsh_ms`（agent 那一轮） |
| **TTS 首块** | 服务端档案 `tts.first.ms` |
| **ASR 重叠** | 播出去的字 vs ASR 认出的字，字符多重集重叠率 |

注意「ASR 定稿→开轮」这一段现在**任何一条连接的第一轮就是稳态**：声学判停
（进程内 ONNX）是进程级一份、启动时预热，连接断开不销毁。要量多轮也可以：

```
node bench/e2e/client.mjs --pcm a.pcm,b.pcm ...   # 一条连接连说两段
```
