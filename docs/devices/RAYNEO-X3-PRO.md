# 雷鸟 X3 Pro：写适配器时的参考

**只按官方文档整理，未上过真机。** 设备侧适配器归用户或手机端实现，插件不内置雷鸟档位；
这份笔记给写适配器的人用。

## 与小米的根本差别

X3 Pro 是一台完整的 Android 12 设备（骁龙 AR1 Gen1），应用直接跑在眼镜上：

- 上行音频是 `AudioRecord` 采到的 **PCM16 16 kHz 单声道**，不是 mSBC。
  `VOICE_RECOGNITION` 收音模式调三颗麦、只收佩戴者；退出时要 `audio_source_record=off` 释放麦克风
- 拍照走 Camera2，直接出 JPEG：没有 P2P、没有相册、**不需要人按快门**
- 没有固件唤醒词，也没有本地 ASR —— 唤醒只能靠手势 / 按键
- 佩戴检测：`MobileState.isWearing()`（SDK ≥ 0.2.6）
- 镜腿触控：`TempleAction`；长按据第三方指南会拉起系统设置面板，归一 `summon` 时建议用单击
- 文档没提回声消除；按主流眼镜惯例应在端侧完成，上真机后确认

## 对应的 `Hello.capabilities`

```json
{
  "audioIn": "pcm16",
  "capture": { "glance": { "needsUser": false }, "detail": { "needsUser": false } },
  "presence": true,
  "power": true,
  "summon": true,
  "listenStart": true,
  "played": true,
  "ignorePhrases": []
}
```

两档拍照都不用确认，所以 `detail` 也能用于主动拍照。`played` 可以用 `AudioTrack` 的播放进度实现。

## 文档来源

- <https://rayneo.gitbook.io/rayneo-devdoc/x-xi-lie/she-bei-jie-shao.md>
- <https://rayneo.gitbook.io/rayneo-devdoc/x-xi-lie/android-kai-fa/neng-li-jie-shao/yin-pin-kai-fa.md>
- `.../android-kai-fa/neng-li-jie-shao/camera-kai-fa.md`
- `.../android-kai-fa/neng-li-jie-shao/pei-dai-jian-ce.md`
- `.../android-kai-fa/neng-li-jie-shao/chu-kong-ban-guan-li.md`
