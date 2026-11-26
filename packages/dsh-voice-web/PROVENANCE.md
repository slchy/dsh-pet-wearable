# 素材来源与许可范围（PROVENANCE）

本包的**代码与配置**按 MIT 许可（见仓根 [`LICENSE`](../../LICENSE)）。`assets/pet/` 目录下的**美术素材**（表情精灵图）**不在 MIT 覆盖范围内**，按如下条款「原样提供」。

## 一、许可边界

| 范围 | 许可 |
| :--- | :--- |
| `src/`、`lib/`、`cordis.patch.yml`、`package.json`、文档与构建脚本 | **MIT**（见仓根 `LICENSE`） |
| `assets/pet/**`（Gemini 娘 10 帧表情精灵 WebP） | **不适用 MIT**：由维护者借助 AI 工具生成并人工挑选、抠图对齐后随本包按 **as-is** 分发，**仅限用于运行本插件**；**不授予再许可**，亦不声明为原创作品。 |

这样划分的原因：程序代码可以明确授予 MIT 许可，而 AI 生成的二次元拟人化形象美术素材无法对下游作出再许可承诺；因此将代码与美术资源严格隔离。

## 二、逐项清单（`256×256` RGBA 透明 WebP）

| 文件 | 语义 / 状态映射 |
| :--- | :--- |
| `assets/pet/calm.webp` | 空闲待机 / 默认态 |
| `assets/pet/speaking.webp` | 语音播报态（配合前端底轴 RMS 摇摆动画） |
| `assets/pet/listening.webp` | 麦克风收音 / 倾听态 |
| `assets/pet/happy.webp` | 开心情绪 |
| `assets/pet/proud.webp` | 得意情绪 |
| `assets/pet/surprised.webp` | 惊讶情绪 |
| `assets/pet/worried.webp` | 担心情绪 |
| `assets/pet/sulk.webp` | 委屈情绪 |
| `assets/pet/angry.webp` | 生气情绪 |
| `assets/pet/disgust.webp` | 嫌弃 / 厌恶情绪 |

## 三、元数据剥离

所有随包分发的 `assets/pet/*.webp` 均经过纯像素重编码并强制剥离 EXIF / XMP / 文本注释块，仅保留渲染必需的 RIFF WebP 图像与 Alpha 通道块（`VP8X` / `ALPH` / `VP8 `）。

## 四、权利主张 / 下架（Takedown）

如果你认为 `assets/pet/` 中的任何素材侵犯了你的合法权益，请在本仓库提交 issue 并说明文件名与依据，我们将在核实后立即替换或移除，不附加其他条件。
