#!/usr/bin/env python3
"""
时间参数总表：从源码扫出所有「会决定某个时刻」的旋钮，生成一张表。

## 为什么是生成而不是手写

旋钮散落在 `envNumber(...)` / `envNum(...)` 和写死的 `*_MS` 常量里。手写这张表
第一个月就会过期，而「眼镜 mSBC 上手动端点配置写 20 ms、实际门槛是一整个上行包」
这类错误恰恰是过期表的产物（`VOICE_COMMIT_MS` 就是活例子）。所以表是**生成物**，
`tests/time-knobs.test.ts` 断言提交的那份与源码一致 —— 改了旋钮忘了重新生成会红灯。

## 每一列回答什么

| 列 | 为什么要有 |
|---|---|
| 数值 | 默认值。和线上不同时，`--prod` 会标出来 |
| 时钟 | **音频时间还是墙上时间**。`frame.silenceMs` 是能量门的墙上时间差，按上行包步进（眼镜 75 ms / 浏览器 20 ms）；按 PCM 字节 / 采样率算的才标 audio |
| 持有者 | 谁读它。改一个参数前先知道改的是哪个模块 |
| 被谁遮住 | 这段等待有没有藏在别的串行环节后面。**遮不住的部分才是纯成本** —— 模型变快后同一条配置从免费变收费，靠这一列发现 |
| 上限 | 这条参数自身还有没有硬顶（预算/拍数），防止「调大了就无限等」 |

## 用法

    python scripts/time-knobs.py              # 打到 stdout
    python scripts/time-knobs.py --write      # 写回 docs/TIME-KNOBS.md
    python scripts/time-knobs.py --prod .env  # 与线上 .env 对照，标出差异

`--prod` 只读键值对，不打印任何值到日志之外的地方 —— 表里只有数字和布尔。
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
OUT = ROOT / "docs" / "TIME-KNOBS.md"

# ---------------------------------------------------------------------------
# 人工标注：源码里读不出来的两列（时钟 / 被谁遮住）。
#
# 键是 `envNumber` / `envNum` 的名字参数，或常量名。**没标注的会落到「未标注」一栏**，
# 那种行在表里一眼可见 —— 与其猜，不如让它显眼。
# ---------------------------------------------------------------------------

#: `EnergyGate` 用墙上时间差算出 `frame.silenceMs`，再按上行音频包步进触发。
#: 眼镜 mSBC 75 ms 一包，浏览器 20 ms PCM 一帧。这六个消费者读的是同一份数。
SILENCE_FRAME_CLOCK = "wall（按上行包步进：眼镜 75 ms / 浏览器 20 ms）"

#: 时钟：audio = 按收到的音频时长算；wall = 按墙上时间算。
#: 只标源码里还在的旋钮。已收进常量的旧 `.env` 名（`VOICE_HOLD_MS` 等）不要留在这里，
#: 否则删掉的名字会继续被当成「已标注」。
CLOCK: dict[str, str] = {
    # 一级：封段 / 静音 / 判停 / 语义
    "VOICE_COMMIT_MS": SILENCE_FRAME_CLOCK,
    "VOICE_STT_COMMIT_MS": SILENCE_FRAME_CLOCK,
    "VOICE_OPEN_QUIET_MS": "wall",
    "TURN_JUDGE_EXTEND_MS": "wall",
    "TURN_JUDGE_WAIT_BUDGET_MS": "wall",
    "TURN_JUDGE_SEQUENCE_BUDGET_MS": "wall",
    "TURN_JUDGE_MAX_OPEN_SILENCE_MS": "wall",
    "SEMANTIC_END_TAG_BUDGET_MS": "wall",
    "FAST_LANE_TIMEOUT_MS": "wall",
    # 一级里的运维超时（仍是 .env，但不在停嘴→出声路径上）
    "MIAI_IDLE_TIMEOUT_MS": "wall",
    "MIAI_PHOTO_TIMEOUT_MS": "wall",
    "MIAI_CONFIRM_TIMEOUT_MS": "wall",
    "MIAI_ANNOUNCE_MAX": "—（条数）",
    "MIAI_ARCHIVE_KEEP": "—（个数）",
    "MIAI_ARCHIVE_MAX_MB": "—（字节）",
    "KEEPALIVE_MINUTES": "wall",
    "MIAI_LEVEL_LOG": "wall（日志周期）",
    # 二级热路径常量（写死在 voice-config.ts；设备封段窗走档案）
    "DEFAULT_GATE_HOLD_MS": "wall",
    "DEFAULT_GATE_PREROLL_MS": "audio",
    "DEFAULT_MIN_SPEECH_MS": "audio",
    "DEFAULT_ASR_PREROLL_MS": "audio",
    "VAD_FRAME_MS": "audio",
    "DEFAULT_PAUSE_DETECT_MS": SILENCE_FRAME_CLOCK,
    "DEFAULT_SPECULATE_MS": SILENCE_FRAME_CLOCK,
    "DEFAULT_TRAILING_TRIM_MS": "audio",
    "DEFAULT_GLASSES_STT_COMMIT_MS": SILENCE_FRAME_CLOCK,
    "DEFAULT_BROWSER_STT_COMMIT_MS": SILENCE_FRAME_CLOCK,
    "ASSEMBLER_FALLBACK_WINDOW_MS": "wall",
    "ASSEMBLER_PREDICT_LEAD_MS": "wall",
    "PREWARM_TTL_MS": "wall",
    # 二级：Omni 影子预卷 / 组句器热路径（写死，不进 .env）
    "DEFAULT_RING_MS": "audio",
    "DEFAULT_DECODE_WAIT_MS": "wall",
    "DEFAULT_SHORT_FRAGMENT_WAIT_MS": "wall",
    "DEFAULT_SHORT_FRAGMENT_WINDOW_MS": "wall",
    "SEMANTIC_MORE_MIN_WAIT_MS": "wall",
    "SEMANTIC_MORE_SEQUENCE_WAIT_MS": "wall",
    # 三级：组句器看门狗 / 模块兜底。分层靠 NOT_ON_PATH。
    "SPEAKING_WATCHDOG_MIN_MS": "wall",
    "SPEAKING_WATCHDOG_MARGIN_MS": "wall",
    "DEFAULT_SEMANTIC_BUDGET_MS": "wall",
    # 三级：看门狗 / 运维 / 诊断。时钟照实标，分层靠 NOT_ON_PATH。
    "DEFAULT_PLAYBACK_TAIL_MS": "wall",
    "DEFAULT_PET_TICK_MS": "wall",
    "DEFAULT_PET_MIC_OPEN_TIMEOUT_MS": "wall",
    "STALL_PROBE_MS": "wall",
    "ABANDON_TIMEOUT_MS": "wall",
    "DEFAULT_DECODE_TIMEOUT_MS": "wall",
    "CLOCK_MISMATCH_MS": "—（判据）",
    "TRUNCATED_EPSILON_MS": "—（判据）",
    "WAITED_THRESHOLD_MS": "—（统计判据）",
    "FIRST_WORD_BUDGET_MS": "wall",
    "SLOW_TURN_MS": "—（统计判据）",
    "PLAYBACK_POLL_MS": "wall",
    "SEMANTIC_SKIP_P": "—（判据）",
    "SEMANTIC_PREFIX_SLACK_CHARS": "—（判据）",
    "CANCEL_GRACE_MS": "wall",
    "FORK_TIMEOUT_MS": "wall",
    "PLAYED_GRACE_MS": "wall",
    "INITIAL_LISTEN_MS": "wall",
    "CAPTURE_GRACE_MS": "wall",
    "HANDSHAKE_WAIT_MS": "wall",
    "DEFAULT_MAX_TURN_MS": "wall",
    "DEFAULT_MAX_STOP_TO_FIRST_MS": "wall",
    "DEFAULT_BARGE_STOP_WITHIN_MS": "wall",
    "RESOLUTION_MS": "wall",
    "DEFAULT_SENTENCE_SILENCE_MS": "audio（服务端）",
    "DEFAULT_TIMEOUT_MS": "wall",
    "RECENT_MS": "wall",
    "TAIL_TTL_MS": "wall",
    "ANNOUNCE_QUIET_MS": "wall",
    "DEFAULT_KEEPALIVE_MS": "wall（连接空闲）",
    "DEFAULT_CAPTURE_TIMEOUT_MS": "wall",
    "DEFAULT_CONFIRM_TIMEOUT_MS": "wall",
    "SUPERSEDED_TTL_MS": "wall",
}

#: 布尔开关没有「时钟」这个概念 —— 它们开关的是机制，不是时长
CLOCK_NA = "—（开关）"

#: 被谁遮住：这段等待有没有藏在别的串行环节后面。
#: `scan()` 只在某项还是空字符串时，才用 NOT_ON_PATH 的默认句填上。
#: 看门狗 / 判据已经写在这里的说明不会被那句盖掉。
SHADED_BY: dict[str, str] = {
    "TURN_JUDGE_EXTEND_MS": "模型段（模型 >200 ms 时几乎全遮住；模型变快后变成纯成本）",
    "TURN_JUDGE_WAIT_BUDGET_MS": "同上 —— 200 是按「模型段 ~184 ms」定的，模型变慢要重算",
    "TURN_JUDGE_MAX_OPEN_SILENCE_MS": "无（它自己是上限）",
    "SEMANTIC_END_TAG_BUDGET_MS": (
        "静候窗（`VOICE_OPEN_QUIET_MS` 200–300 ms）—— 判停请求在定稿时已发出，"
        "等不到就按「说完了」放行；同时作为超时上限（`semanticTimeoutMs` 与预算同一值）。"
        "Pure Live 默认关闭，`SEMANTIC_END_TAG=1` 才开"
    ),
    "DEFAULT_PAUSE_DETECT_MS": "ASR 解出句之前（提前起跑，不额外等）",
    "DEFAULT_SPECULATE_MS": "ASR 解出句之前（Cascade 投机与 ASR 并行；Pure Live 自动归 0）",
    "PREWARM_TTL_MS": "定稿→开轮之间（正常 0–600 ms，用不完）",
    "STALL_PROBE_MS": "无（纯诊断看门狗：正常轮首块 ~350 ms 就拆掉，不产生任何等待）",
    "DEFAULT_DECODE_TIMEOUT_MS": "无关首声（纯防卡死看门狗：正常 ASR 定稿 ~200 ms 即拆掉，只在服务端丢回包时触发解锁）",
    "CLOCK_MISMATCH_MS": "无（纯判据：只用来发现两把时钟接错，不放慢任何东西）",
    "SEMANTIC_SKIP_P": "无（纯判据：声学已经很确定时**省掉**一段等待）",
    "SEMANTIC_PREFIX_SLACK_CHARS": "无（纯判据：决定定稿要不要再问一趟语义判停）",
    "TRUNCATED_EPSILON_MS": "无（纯判据：轮末判「用户少听了没有」，不产生任何等待）",
    "ABANDON_TIMEOUT_MS": "无关首声（只在「上一条合成已作废」时出现；正常轮等到 done 就走，不进这个循环）",
    "ASSEMBLER_PREDICT_LEAD_MS": "ASR 出句之前",
    "DEFAULT_RING_MS": "无（Omni 影子旁路静音期环形预卷长度，防软起音被裁，不加延迟）",
    "DEFAULT_DECODE_WAIT_MS": "开轮前硬等在途 ASR 解码收尾上限（直接计入首声；超时按当前文本放行）",
    "DEFAULT_SHORT_FRAGMENT_WAIT_MS": (
        "短碎片与语义 more 的单拍兜底上限（实际受 `TURN_JUDGE_WAIT_BUDGET_MS` / "
        "`TURN_JUDGE_MAX_OPEN_SILENCE_MS` 夹住）"
    ),
    "DEFAULT_SHORT_FRAGMENT_WINDOW_MS": "距上一轮收下多久内的极短句算碎片（时间邻接判据，命中后触发短碎片等待）",
    "SEMANTIC_MORE_MIN_WAIT_MS": (
        "普通静音上限下语义 `more` 的单拍下限（受 `TURN_JUDGE_MAX_OPEN_SILENCE_MS - quietNow` "
        "与短碎片上限夹住）"
    ),
    "SEMANTIC_MORE_SEQUENCE_WAIT_MS": (
        "序列预算大于普通静音上限时语义 `more` 的单拍等待（受 "
        "`TURN_JUDGE_SEQUENCE_BUDGET_MS - quietNow` 夹住）"
    ),
    "SPEAKING_WATCHDOG_MIN_MS": (
        "无关首声（`speaking_more` 断流兜底定时器最短等待；持续说话期间每帧刷新，仅彻底停帧时防卡死）"
    ),
    "SPEAKING_WATCHDOG_MARGIN_MS": (
        "无关首声（`speaking_more` 断流兜底相对静默/延长门槛的余量，确保晚于正常静音收口）"
    ),
    "DEFAULT_SEMANTIC_BUDGET_MS": (
        "模块兜底默认（生产由 `SEMANTIC_END_TAG_BUDGET_MS` 覆写；"
        "仅直接调 `UtteranceAssembler` 未传 `semanticBudgetMs` 时生效）"
    ),
    "PLAYBACK_POLL_MS": "设备播报期间（轮询，不加延迟）",
    "DEFAULT_GATE_PREROLL_MS": "无（它是滑窗长度，不加延迟）",
    "DEFAULT_MIN_SPEECH_MS": (
        "无（单段有效有声不足 120 ms 不封段、不投机、不预跑；够了才进入静音门槛，不加额外等待）"
    ),
    "DEFAULT_ASR_PREROLL_MS": (
        "无（开门时 ASR/Omni 只吃预卷尾部；TurnJudge 仍用完整 DEFAULT_GATE_PREROLL_MS，不加延迟）"
    ),
    "VAD_FRAME_MS": "无（神经 VAD 的帧长，时间戳按它倒推，不加额外等待）",
    "DEFAULT_GATE_HOLD_MS": "无（决定 gate.close 何时落，① 的起点；必须大于封段与开轮静音天花板）",
    "DEFAULT_TRAILING_TRIM_MS": "判停侧车输入预处理（不额外等）",
    "TURN_JUDGE_SEQUENCE_BUDGET_MS": "模型段（只对数字/字母/「然后」这类句尾生效）",
    "VOICE_COMMIT_MS": "无 —— 它就是封段的那一刻，实际门槛被上行包长盖住",
    "VOICE_STT_COMMIT_MS": "无（150 ms 仍早于判停的 200–300 ms 静音门槛，解码与判停那一拍重叠）",
    "DEFAULT_GLASSES_STT_COMMIT_MS": "无（glasses 档案的 VOICE_STT_COMMIT_MS 默认值，仍早于 200–300 ms 开轮静音门槛）",
    "DEFAULT_BROWSER_STT_COMMIT_MS": "无（browser 档案的 VOICE_STT_COMMIT_MS 默认值，浏览器开 AGC 后放宽防词中切断）",
    "VOICE_OPEN_QUIET_MS": "ASR 已出句、等静音够了才开轮（**这段是纯等待**）",
    "ASSEMBLER_FALLBACK_WINDOW_MS": (
        "仅在无判停器且未设开轮静音门槛（服务端 VAD / NLS）时生效；"
        "手动端点配了 `VOICE_OPEN_QUIET_MS` 时不再盲等 600 ms"
    ),
    "FIRST_WORD_BUDGET_MS": "无（它是报警线，不约束任何环节）",
    "FAST_LANE_TIMEOUT_MS": "模型段（它就是那一轮的上限）",
    "DEFAULT_PLAYBACK_TAIL_MS": "无关首声（播完后等扬声器尾音散尽，防回声）",
    # 保活不产生延迟；超过服务端空闲才会让下一次请求打到已关的连接上
    "DEFAULT_KEEPALIVE_MS": "无关首声（不产生延迟，只在超过服务端空闲时导致连接失效）",
    # 统计判据：它们不约束任何环节，只决定报告怎么分组/计数
    "WAITED_THRESHOLD_MS": "无（报告分组门槛，不参与调度）",
    "SLOW_TURN_MS": "无（报告里的「慢轮」门槛）",
    # 路径布尔开关。这五个 Cascade 开关都不进 NOT_ON_PATH：
    # 前四个直接省首声，FAST_LANE_DELEGATE 直接改路径。套上「无关首声」会把它们藏进三级。
    "FAST_LANE_DELEGATE": (
        "直接改路径（Cascade 路径：0=纯聊天模型直答不委派；1=短句直答、复杂任务委派 dsh，"
        "开启后委派轮走慢车道；Pure Live 不走）"
    ),
    "COSYVOICE_PREWARM": (
        "直接省首声（Cascade 路径：定稿→开轮间提前建 TTS task，把建连/开流藏进判停等待；"
        "关掉首块多付冷开开销；Pure Live 不走 CosyVoice）"
    ),
    "FAST_LANE_SPECULATE": (
        "直接省首声（Cascade 路径：快模型与 dsh 并行投机，把委派轮的快车道判定藏进 dsh 首字里；"
        "关掉退回串行，委派轮白等一次判定；Pure Live 不走）"
    ),
    "FAST_LANE_PARTIAL_SPECULATE": (
        "直接省首声（Cascade 路径：在 ASR 定稿前 100 ms 用中间结果提前发快模型，给提前合成音频腾窗口；"
        "关掉丢失这段重叠窗口；Pure Live 不走）"
    ),
    "FAST_LANE_PREFETCH": (
        "直接省首声（Cascade 路径：ASR 定稿即提前起跑快模型，与判停静候窗重叠；"
        "关掉退回开轮才发请求，直接增加首声延迟；Pure Live 不走）"
    ),
    "PET_PROACTIVE": "无关首声（控制宠物主动开口，不在用户停嘴→出声路径上）",
    "DEFAULT_SENTENCE_SILENCE_MS": (
        "仅旧 NLS 路径（`--stt aliyun`）：服务端判句纯静音等待；"
        "`qwen-realtime` 与 Pure Live 不用"
    ),
    "DEFAULT_TIMEOUT_MS": (
        "模块兜底默认（生产由 `SEMANTIC_END_TAG_BUDGET_MS` 覆写；"
        "仅直接调 `semanticEndpoint` 未传 `timeoutMs` 时生效）"
    ),
}

#: 上限：这条参数有没有硬顶
CAP: dict[str, str] = {
    "TURN_JUDGE_EXTEND_MS": (
        "TURN_JUDGE_MAX_EXT=2 拍 / WAIT_BUDGET_MS=200（普通句一拍满即触顶，"
        "第 2 拍仅留给 <200 ms 静音闸门、语义 more 豁免或序列句）/ MAX_OPEN_SILENCE_MS"
    ),
    "TURN_JUDGE_MAX_EXT": "TURN_JUDGE_WAIT_BUDGET_MS",
    "TURN_JUDGE_MAX_UNSURE": "TURN_JUDGE_MAX_EXT（两条取小）",
    "VOICE_COMMIT_MS": (
        "眼镜 mSBC + 手动端点下实际门槛 = 一整个上行包（75 ms）；"
        "浏览器 20 ms PCM 帧可按帧触发；服务端 VAD / 非 qwen-realtime 归 0"
    ),
    "FAST_LANE_TIMEOUT_MS": "FAST_LANE > 0 时固定；超时转 dsh",
    "TURN_JUDGE_SEQUENCE_BUDGET_MS": (
        "声学静音受 TURN_JUDGE_MAX_OPEN_SILENCE_MS 封顶；"
        "语义 more 豁免后受 DEFAULT_GATE_HOLD_MS（2000 ms）封顶"
    ),
}

#: 不在「停嘴 → 出声」热路径上的。常量进这个集合就会落到表格的「三级」，
#: 而不是「二级热路径」。这些不是遗漏 —— 改它们不会动首声延迟。
#:
#: `scan()` 仅在 `shaded == ""` 时填「无关首声（不在停嘴→出声路径上）」。
#: 已经写了精准 `SHADED_BY` 的看门狗 / 判据保持原文，不会被这句盖掉。
NOT_ON_PATH = {
    "MIAI_IDLE_TIMEOUT_MS",
    "MIAI_PHOTO_TIMEOUT_MS",
    "MIAI_CONFIRM_TIMEOUT_MS",
    "DEFAULT_CONFIRM_TIMEOUT_MS",
    "DEFAULT_CAPTURE_TIMEOUT_MS",
    "DEFAULT_KEEPALIVE_MS",
    "MIAI_ANNOUNCE_MAX",
    "MIAI_ARCHIVE_KEEP",
    "MIAI_ARCHIVE_MAX_MB",
    "MIAI_LEVEL_LOG",
    "DEFAULT_PET_MIC_OPEN_TIMEOUT_MS",
    "DEFAULT_PET_TICK_MS",
    "DEFAULT_PLAYBACK_TAIL_MS",
    "PET_PROACTIVE",
    "TAIL_TTL_MS",
    "SUPERSEDED_TTL_MS",
    "ANNOUNCE_QUIET_MS",
    "RECENT_MS",
    "DEFAULT_TIMEOUT_MS",
    "FORK_TIMEOUT_MS",
    "CANCEL_GRACE_MS",
    "INITIAL_LISTEN_MS",
    "CAPTURE_GRACE_MS",
    "HANDSHAKE_WAIT_MS",
    "DEFAULT_MAX_TURN_MS",
    "DEFAULT_MAX_STOP_TO_FIRST_MS",
    "DEFAULT_BARGE_STOP_WITHIN_MS",
    "RESOLUTION_MS",
    "DEFAULT_SENTENCE_SILENCE_MS",
    "PLAYED_GRACE_MS",
    "PLAYBACK_POLL_MS",
    "KEEPALIVE_MINUTES",
    # 看门狗 / 判据 / 离线诊断：有自己的 SHADED_BY，放进来只为把它们从二级热路径挪走
    "STALL_PROBE_MS",
    "ABANDON_TIMEOUT_MS",
    "DEFAULT_DECODE_TIMEOUT_MS",
    "CLOCK_MISMATCH_MS",
    "TRUNCATED_EPSILON_MS",
    "WAITED_THRESHOLD_MS",
    "FIRST_WORD_BUDGET_MS",
    "SLOW_TURN_MS",
    # 组句器看门狗 / 模块兜底：有自己的 SHADED_BY，放进来只为离开二级热路径
    "SPEAKING_WATCHDOG_MIN_MS",
    "SPEAKING_WATCHDOG_MARGIN_MS",
    "DEFAULT_SEMANTIC_BUDGET_MS",
}

ENV_RE = re.compile(
    r"(?:envNumber\(\s*|envNum\(\s*\w+\s*,\s*)'([A-Z0-9_]+)'\s*,\s*(.+?)\)\s*[,);]"
)
CONST_RE = re.compile(
    # `const X_MS = ...` 和 `private static readonly X_MS = ...` 两种写法都要认：
    # 后者没有 `const` 关键字（`PREWARM_TTL_MS` 就是这么写的，漏了会让不变量查不到）
    r"^\s*(?:export\s+)?(?:(?:private|public|protected|static|readonly)\s+)*(?:const\s+)?"
    r"([A-Z][A-Z0-9_]*_(?:MS|MINUTES|POLL_MS|GRACE_MS))\s*=\s*(.+?);"
)
PROCESS_RE = re.compile(
    r"(?:process\.env|env)\['([A-Z0-9_]+)'\]\s*(?:\?\?\s*'([^']*)'\s*\)\s*)?(!==|===)\s*'([^']*)'"
)

#: 名字不像时间、但确实会改变某个时刻的开关。别的开关（阈值、字数、路数）不进这张表 ——
#: 它们影响的是「走哪条路」，不是「等多久」，混进来会让表失去焦点。
TIMING_FLAGS = {
    "FAST_LANE_PREFETCH",
    "FAST_LANE_SPECULATE",
    "FAST_LANE_PARTIAL_SPECULATE",
    "FAST_LANE_DELEGATE",
    "COSYVOICE_PREWARM",
    "PET_PROACTIVE",
}

TIME_KEY_RE = re.compile(r"_(?:MS|MINUTES)$")


@dataclass
class Knob:
    """一个时间参数。"""

    name: str
    default: str
    file: str
    line: int
    kind: str  # env | const | flag
    clock: str = ""
    shaded: str = ""
    cap: str = ""
    extra: list[str] = field(default_factory=list)


def fmt_number(raw: str) -> str:
    """把源码里的写法换成好读的形式：`1_200` → `1200`，`5 * 60_000` → `300000`。"""
    text = raw.strip()
    # 去掉尾随注释
    if "//" in text:
        text = text.split("//", 1)[0].strip()
    # 嵌套 envNumber（`envNumber('MIAI_X', envNumber('X', 4))`）：取内层的默认值，
    # 外面那层只是给旧变量名留的兼容入口
    nested = re.search(r"envNumber\('[A-Z0-9_]+'\s*,\s*([0-9_]+)\)", text)
    if nested is not None:
        text = nested.group(1)
    # 三元（`stt === 'x' ? 20 : 0`）：取非零分支，并附上条件
    ternary = re.fullmatch(r"\w+\s*===\s*'([^']+)'\s*\?\s*([0-9_]+)\s*:\s*([0-9_]+)", text)
    if ternary is not None:
        hot, cold = ternary.group(2), ternary.group(3)
        pick = hot if int(hot.replace("_", "")) != 0 else cold
        return f"{int(pick.replace('_', ''))}（仅 {ternary.group(1)}）"
    try:
        # 只处理纯数字和「数字 * 数字」两种形态
        if re.fullmatch(r"[0-9_]+", text):
            return str(int(text.replace("_", "")))
        m = re.fullmatch(r"([0-9_]+)\s*\*\s*([0-9_]+)", text)
        if m:
            return str(int(m.group(1).replace("_", "")) * int(m.group(2).replace("_", "")))
        m = re.fullmatch(r"([0-9_]+)\s*\*\s*([0-9_]+)\s*\*\s*([0-9_]+)", text)
        if m:
            a, b, c = (int(g.replace("_", "")) for g in m.groups())
            return str(a * b * c)
    except ValueError:
        pass
    return text


def is_time(name: str, kind: str) -> bool:
    """这个名字是不是「等多久」一类的参数。"""
    if kind == "flag":
        return name in TIMING_FLAGS
    return bool(TIME_KEY_RE.search(name))


def scan() -> list[Knob]:
    """扫 src/，按文件行号顺序返回所有时间参数。"""
    found: list[Knob] = []
    seen_env: dict[str, int] = {}
    seen_const: set[str] = set()

    for path in sorted(SRC.rglob("*.ts")):
        rel = path.relative_to(ROOT).as_posix()
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            stripped = line.strip()
            # 注释行不算
            if stripped.startswith(("//", "*", "/*")):
                continue

            for m in ENV_RE.finditer(line):
                name, raw = m.group(1), m.group(2)
                if name in seen_env:
                    continue
                seen_env[name] = lineno
                if not is_time(name, "env"):
                    continue
                # 一行里可能有两个 envNumber（两个超时相加），raw 会被贪婪匹配吃掉 ——
                # 这种情况下只认紧跟在名字后面的那个数字
                own = re.match(r"([0-9_]+|[A-Za-z0-9_.]+(?:\s*\*\s*[0-9_]+)*)", raw)
                if own is not None and "envNumber" in raw:
                    raw = own.group(1)
                found.append(Knob(name, fmt_number(raw), rel, lineno, "env"))

            m = CONST_RE.match(line)
            if m:
                name, raw = m.group(1), m.group(2)
                if name in seen_const:
                    continue
                seen_const.add(name)
                if not is_time(name, "const"):
                    continue
                found.append(Knob(name, fmt_number(raw), rel, lineno, "const"))

            # 布尔开关：`process.env['NAME']` 与 `env['NAME']`，可选 `(?? 'default')`
            for m in PROCESS_RE.finditer(line):
                name, fallback, op, rhs = m.group(1), m.group(2), m.group(3), m.group(4)
                if name in seen_env or name not in TIMING_FLAGS:
                    continue
                if fallback is not None:
                    # `(env['NAME'] ?? '0') !== '0'` → 默认关。
                    default_true = (fallback != rhs) if op == "!==" else (fallback == rhs)
                    default = "1" if default_true else "0"
                else:
                    # `!== '0'` 不设就是开；`=== '1'` 不设就是关。
                    default = "1" if op == "!==" else "0"
                seen_env[name] = lineno
                found.append(Knob(name, default, rel, lineno, "flag"))

    for knob in found:
        knob.clock = CLOCK.get(knob.name, "")
        knob.shaded = SHADED_BY.get(knob.name, "")
        knob.cap = CAP.get(knob.name, "")
        if knob.kind == "flag" and knob.clock == "":
            knob.clock = CLOCK_NA
        if knob.shaded == "" and knob.name in NOT_ON_PATH:
            knob.shaded = "无关首声（不在停嘴→出声路径上）"

    # `VOICE_STT_COMMIT_MS` 的回退值是 `profile.sttCommitMs`，扫描器读到的是标识符。
    # 两档设备档案的数字在同一次扫描里：拼进默认值，表格能看见 150/320，
    # `numeric()` 仍取前导数字做不变量检查。
    glasses = next((k.default for k in found if k.name == "DEFAULT_GLASSES_STT_COMMIT_MS"), None)
    browser = next((k.default for k in found if k.name == "DEFAULT_BROWSER_STT_COMMIT_MS"), None)
    if glasses is not None and browser is not None:
        profile_default = f"{glasses}（glasses）/ {browser}（browser）"
        for knob in found:
            if knob.default == "profile.sttCommitMs":
                knob.default = profile_default
    return found


# ---------------------------------------------------------------------------
# L1：时序不变量
#
# 与 `validateVoiceTiming` 的单配置不变量对齐，并额外守跨模块源码默认值
# （`PREWARM_TTL_MS` / `DEFAULT_KEEPALIVE_MS` / `SEMANTIC_MORE_*_WAIT_MS`）。
# 数值从源码扫出来，测的是**真正会上线**的默认值，不是文档里抄的。
#
# `(左, 关系, 右, 违反后的后果)`
# ---------------------------------------------------------------------------

INVARIANTS: list[tuple[str, str, str, str]] = [
    (
        "DEFAULT_SPECULATE_MS", "<=", "DEFAULT_PAUSE_DETECT_MS",
        "判停预跑抢在投机前面起跑：投机那 100 ms 的提前量白丢，等于白花钱",
    ),
    (
        "VOICE_STT_COMMIT_MS", ">=", "VOICE_COMMIT_MS",
        "ASR 封段早于 omni 车道起跑：两路时序倒挂",
    ),
    (
        "DEFAULT_BROWSER_STT_COMMIT_MS", ">=", "VOICE_COMMIT_MS",
        "browser 档案 ASR 封段早于 omni 车道起跑：两路时序倒挂",
    ),
    (
        "TURN_JUDGE_WAIT_BUDGET_MS", ">=", "TURN_JUDGE_EXTEND_MS",
        "预算比一拍还短，等于没有预算；`EXTEND_MS` 一改就会撞",
    ),
    (
        "TURN_JUDGE_SEQUENCE_BUDGET_MS", ">=", "TURN_JUDGE_WAIT_BUDGET_MS",
        "序列预算低于普通等待预算，序列豁免失效",
    ),
    (
        "TURN_JUDGE_MAX_OPEN_SILENCE_MS", ">=", "VOICE_OPEN_QUIET_MS",
        "开轮静音门槛永远够不着，只能撞上限放行",
    ),
    (
        "DEFAULT_ASR_PREROLL_MS", "<=", "DEFAULT_GATE_PREROLL_MS",
        "ASR/Omni 预卷长过能量门滑窗，尾部没有完整预卷可裁",
    ),
    (
        "DEFAULT_MIN_SPEECH_MS", "<", "DEFAULT_GATE_HOLD_MS",
        "最短有效人声不短于能量门保持，正常一句还没攒够门就关了",
    ),
    (
        "DEFAULT_GATE_HOLD_MS", ">", "VOICE_STT_COMMIT_MS",
        "能量门在眼镜 ASR 封段到达前先关门",
    ),
    (
        "DEFAULT_GATE_HOLD_MS", ">", "DEFAULT_BROWSER_STT_COMMIT_MS",
        "能量门在浏览器 ASR 封段到达前先关门",
    ),
    (
        "DEFAULT_GATE_HOLD_MS", ">", "VOICE_OPEN_QUIET_MS",
        "能量门在开轮静音门槛到达前先关门",
    ),
    (
        "DEFAULT_GATE_HOLD_MS", ">", "TURN_JUDGE_MAX_OPEN_SILENCE_MS",
        "能量门在开轮静音上限到达前先关门，导致提前截断或挂断",
    ),
    (
        "DEFAULT_GATE_HOLD_MS", ">", "TURN_JUDGE_SEQUENCE_BUDGET_MS",
        "语义 `more` / 序列句续等会用到序列预算（1200 ms），序列预算一旦顶过能量门保持，门会先关",
    ),
    (
        "PREWARM_TTL_MS", ">", "TURN_JUDGE_SEQUENCE_BUDGET_MS",
        "序列句等满预算时预热 task 已过期，那类轮次要付一次冷启动",
    ),
    (
        "DEFAULT_KEEPALIVE_MS", "<", "SERVER_IDLE_TIMEOUT_MS",
        "复用到一条服务端已关的连接 —— 那一次请求**直接失败**，比多 100 ms 糟得多",
    ),
    (
        "TURN_JUDGE_MAX_OPEN_SILENCE_MS", ">=", "SEMANTIC_MORE_MIN_WAIT_MS",
        "普通静音上限低于语义 `more` 单拍下限，下限永远触顶",
    ),
    (
        "TURN_JUDGE_SEQUENCE_BUDGET_MS", ">=", "SEMANTIC_MORE_SEQUENCE_WAIT_MS",
        "序列预算低于语义 `more` 序列单拍等待，序列单拍永远被压死",
    ),
]

#: 服务端空闲超时的**下界**（秒级）。实测：`https.Agent` 空闲 60 s 仍能复用。
#: **上界未测** —— 所以这里只能验「保活短于 60 s」，不能声称服务端就是 60 s。
SERVER_IDLE_TIMEOUT_MS = 60_000

#: **警告**（不是失败）：保活超过这个值就落进「没实测过」的区间。
#: 目前 50 s > 45 s —— 真机最大轮间隔 16.7 s 从没触及，但没人验证过 50 s 还行。
KEEPALIVE_VERIFIED_MS = 45_000


def numeric(knobs: list[Knob]) -> dict[str, int]:
    """扫出来的默认值 → 整数。

    两种间接都要解开：
    - `20（仅 qwen-realtime）`、`150（glasses）/ 320（browser）` 这类带注释的，取前导数字；
    - `MIAI_CONFIRM_TIMEOUT_MS` 的默认值是**标识符** `DEFAULT_CONFIRM_TIMEOUT_MS`，
      要回到常量表里取值 —— 不解析它，不变量就查不到这个参数。
    """
    by_name = {knob.name: knob.default for knob in knobs}
    out: dict[str, int] = {}
    for name, raw in by_name.items():
        seen: set[str] = set()
        value = raw
        while re.fullmatch(r"[A-Z][A-Z0-9_]*", value) and value in by_name and value not in seen:
            seen.add(value)
            value = by_name[value]
        m = re.match(r"(\d+)", value)
        if m is not None:
            out[name] = int(m.group(1))
    return out


def check_invariants(knobs: list[Knob]) -> tuple[list[str], list[str]]:
    """校验 L1 不变量。返回 `(错误, 警告)` 两组文本。"""
    values = numeric(knobs)
    values["SERVER_IDLE_TIMEOUT_MS"] = SERVER_IDLE_TIMEOUT_MS
    fails: list[str] = []
    warns: list[str] = []

    for left, op, right, why in INVARIANTS:
        a, b = values.get(left), values.get(right)
        if a is None or b is None:
            fails.append(f"缺参数：`{left}` 或 `{right}` 没扫到（名字改了？）")
            continue
        ok = a <= b if op == "<=" else a >= b if op == ">=" else a < b if op == "<" else a > b
        if not ok:
            fails.append(f"{left}={a} {op} {right}={b} 不成立 —— {why}")

    keepalive = values.get("DEFAULT_KEEPALIVE_MS")
    if keepalive is not None and KEEPALIVE_VERIFIED_MS < keepalive < SERVER_IDLE_TIMEOUT_MS:
        warns.append(
            f"DEFAULT_KEEPALIVE_MS={keepalive} 超过实测验证过的 "
            f"{KEEPALIVE_VERIFIED_MS}（`fetch` 只验到空闲 45 s；60 s 是 `https.Agent` 的结果）"
        )
    return fails, warns


def read_prod(path: Path) -> dict[str, str]:
    """读线上 `.env`。只用键值，值绝不会出现在生成物里（只用于比数字）。"""
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line == "" or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = value.strip().strip('"').strip("'")
    return out


def render(knobs: list[Knob], prod: dict[str, str] | None) -> str:
    """生成 Markdown。"""
    lines: list[str] = [
        "# 时间参数总表",
        "",
        "> **这是生成物，别手改。** 重新生成：`python scripts/time-knobs.py --write`；",
        "> `tests/time-knobs.test.ts` 会断言这份文件与源码一致。",
        ">",
        "> 为什么要有这张表：项目里既有「眼镜 mSBC + 手动端点下，配置写 20 ms、",
        "> 实际门槛是一整个上行包」这种**口径错位**，",
        "> 也有「模型变快后同一条等待从免费变成纯成本」这种**遮盖关系变化**。两件事",
        "> 都只能靠「时钟」和「被谁遮住」两列看出来。",
    ]
    if prod is not None:
        lines.append(">")
        lines.append("> 带 ⚠ 的行表示**代码默认值与线上不同** —— 改这些之前先确认线上为什么不一样。")
    lines.append("")

    env_knobs = [k for k in knobs if k.kind == "env"]
    flag_knobs = [k for k in knobs if k.kind == "flag"]
    const_knobs = [k for k in knobs if k.kind == "const"]
    # 二级 = 热路径常量；三级 = 看门狗 / 运维 / 诊断。分界只看 NOT_ON_PATH。
    hot_const_knobs = [k for k in const_knobs if k.name not in NOT_ON_PATH]
    ops_const_knobs = [k for k in const_knobs if k.name in NOT_ON_PATH]

    def table(rows: list[Knob], title: str, note: str) -> None:
        lines.append(f"## {title}")
        lines.append("")
        lines.append(note)
        lines.append("")
        lines.append("| 参数 | 默认 | 时钟 | 持有者 | 被谁遮住 | 上限 |")
        lines.append("|:---|:---:|:---|:---|:---|:---|")
        for k in rows:
            mark = ""
            if prod is not None and k.kind in ("env", "flag"):
                actual = prod.get(k.name)
                if actual is not None and actual != k.default:
                    mark = " ⚠"
            shadow = k.shaded or "**未标注**"
            cap = k.cap or "—"
            clock = k.clock or "**未标注**"
            lines.append(
                f"| `{k.name}`{mark} | {k.default} | {clock} | "
                f"`{k.file}:{k.line}` | {shadow} | {cap} |"
            )
        lines.append("")

    table(
        env_knobs,
        "一、一级运行旋钮（.env 公开可调）",
        f"共 {len(env_knobs)} 项。扫描认 `envNumber` 与 `envNum`。",
    )
    table(
        flag_knobs,
        "二、路径布尔开关（会改变时刻或路径）",
        f"共 {len(flag_knobs)} 项。",
    )
    table(
        hot_const_knobs,
        "三、二级热路径内部常量（写死代码，受不变量约束）",
        f"共 {len(hot_const_knobs)} 项。写死在代码里，不进 `.env`；"
        "单配置关系由 `validateVoiceTiming` 守，`--check` 对齐同一套并补上跨模块默认值。",
    )
    table(
        ops_const_knobs,
        "四、三级看门狗、运维超时与离线诊断阈值（无关首声热路径）",
        f"共 {len(ops_const_knobs)} 项。不在停嘴→出声路径上，改它们不动首声。",
    )

    unmarked_clock = [k.name for k in knobs if not k.clock]
    unmarked_shadow = [k.name for k in knobs if not k.shaded and k.clock not in ("—（条数）", "—（个数）", "—（字节）")]
    lines.append("## 五、还没标注的")
    lines.append("")
    lines.append("这些不是遗漏登记，是**还没查清**。填之前不要凭直觉写 —— 「时钟」写错")
    lines.append("比空着更糟，因为空着会被当成待办、写错会被当成结论。")
    lines.append("")
    lines.append(f"- 缺「时钟」：{'、'.join(f'`{n}`' for n in unmarked_clock) if unmarked_clock else '（无）'}")
    lines.append(f"- 缺「被谁遮住」：{'、'.join(f'`{n}`' for n in unmarked_shadow) if unmarked_shadow else '（无）'}")
    lines.append("")

    lines.append("## 六、从这张表里读出来的结论")
    lines.append("")
    lines.append("**1. `VOICE_COMMIT_MS` 的「20 ms 失效」只在眼镜 mSBC + 手动端点下成立。**")
    lines.append("")
    lines.append("眼镜上行 75 ms 一包，同一个包尾部的静音不计入 `frame.silenceMs`，")
    lines.append("所以配置 20 与 40 只在包边界上有差别，实际门槛是一整个上行包。")
    lines.append("浏览器端是 20 ms PCM 帧，20 ms 可以按帧触发。")
    lines.append("`QWEN_ASR_TURN_DETECTION=vad`，或 STT 不是 `qwen-realtime` 时，`commitMs` 直接归 0。")
    lines.append("")
    lines.append("**2. 判停等待（`TURN_JUDGE_*`）现在是纯成本，且普通句上 `MAX_EXT=2` 已被 `WAIT_BUDGET_MS=200` 压成单拍。**")
    lines.append("")
    lines.append("当前 `WAIT_BUDGET_MS`（200）与 `EXTEND_MS`（200）相等。")
    lines.append("普通句走完一拍完整的声学延长，预算就耗尽；这段等待不再被模型段盖住，等满就是纯成本。")
    lines.append("第 2 拍只在三类情况触发：静音闸门先等了不到 200 ms；")
    lines.append("语义判停明确回 `more`（`unsureAteBudget()` 豁免）；")
    lines.append("序列句改走 `WAIT_BUDGET_SEQUENCE_MS=1200`。")
    lines.append("")
    lines.append(
        f"**3. 总表按三层旋钮 + 独立开关节共四张表组织（合计 {len(knobs)} 项），双检口径对齐。**"
    )
    lines.append("")
    lines.append("四张表是：一级 `.env` 公开可调的运行旋钮；路径布尔开关；")
    lines.append("二级热路径内部常量；三级看门狗、运维超时与离线诊断阈值。")
    lines.append(f"合计 {len(knobs)} 项，这个数由扫描结果填上，不在文里写死。")
    lines.append("")
    lines.append("`validateVoiceTiming` 守全部单配置运行时不变量，非法组合进不了会话。")
    lines.append("`--check` 对齐同一套，并额外守跨模块源码默认值")
    lines.append("（`PREWARM_TTL_MS` / `DEFAULT_KEEPALIVE_MS` / `SEMANTIC_MORE_*_WAIT_MS`）。")
    lines.append("改了一个数让另一条门槛够不着，这里也会红。")
    lines.append("")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="生成时间参数总表 / 校验跨参数不变量")
    ap.add_argument("--write", action="store_true", help="写回 docs/TIME-KNOBS.md")
    ap.add_argument("--check", action="store_true",
                    help="只校验 L1 不变量（跨参数关系），不生成表；有违反时 exit 1")
    ap.add_argument("--prod", type=Path, default=None, help="与线上 .env 对照（标出默认值差异）")
    args = ap.parse_args(argv)

    knobs = scan()

    if args.check:
        fails, warns = check_invariants(knobs)
        for line in warns:
            print(f"警告: {line}")
        for line in fails:
            print(f"违反: {line}")
        if fails:
            print(f"\n{len(fails)} 条不变量不成立（共 {len(INVARIANTS)} 条）", file=sys.stderr)
            return 1
        print(f"{len(INVARIANTS)} 条不变量全部成立"
              + (f"（{len(warns)} 条警告）" if warns else ""))
        return 0

    prod = read_prod(args.prod) if args.prod is not None else None
    text = render(knobs, prod)

    if args.write:
        OUT.write_text(text, encoding="utf-8", newline="\n")
        print(f"已写入 {OUT.relative_to(ROOT)}（{len(knobs)} 项）", file=sys.stderr)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
