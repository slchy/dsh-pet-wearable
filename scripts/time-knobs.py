#!/usr/bin/env python3
"""
时间参数总表：从源码扫出所有「会决定某个时刻」的旋钮，生成一张表。

## 为什么是生成而不是手写

`sources` 里现在有 40 多个 `envNumber(...)` 和 20 多个硬编码的 `*_MS`。手写这张表
第一个月就会过期，而「配置写 20 ms、实际门槛 75 ms」这类错误恰恰是过期表的产物
（`VOICE_COMMIT_MS` 就是活例子）。所以表是**生成物**，`tests/time-knobs.test.ts`
断言提交的那份与源码一致 —— 改了旋钮忘了重新生成会红灯。

## 每一列回答什么

| 列 | 为什么要有 |
|---|---|
| 数值 | 默认值。和线上不同时，`--prod` 会标出来 |
| 时钟 | **音频时间还是墙上时间**。封段按墙上时间算，而静音帧在同一包里不参与计时 —— 「20 ms 其实是 75 ms」就是这么来的 |
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
# 键是 `envNumber` 的第一个参数或常量名。**没标注的会落到「未标注」一栏**，
# 那种行在表里一眼可见 —— 与其猜，不如让它显眼。
# ---------------------------------------------------------------------------

#: 时钟：audio = 按收到的音频时长算；wall = 按墙上时间算
CLOCK: dict[str, str] = {
    # 封段 / 静音
    "VOICE_COMMIT_MS": "wall→audio（见下方备注）",
    "VOICE_PAUSE_DETECT_MS": "wall",
    "VOICE_SPECULATE_MS": "wall",
    "VOICE_HOLD_MS": "wall",
    "VOICE_PREROLL_MS": "audio",
    "VOICE_OPEN_QUIET_MS": "audio",
    "VOICE_OPEN_QUIET_SHORT_MS": "audio",
    "QWEN_ASR_VAD_SILENCE_MS": "wall（服务端）",
    # 判停
    "TURN_JUDGE_EXTEND_MS": "wall",
    "TURN_JUDGE_WAIT_BUDGET_MS": "wall",
    "TURN_JUDGE_SEQUENCE_BUDGET_MS": "wall",
    "TURN_JUDGE_QUIET_MS": "wall",
    "TURN_JUDGE_MAX_OPEN_SILENCE_MS": "audio",
    "TURN_JUDGE_TRIM_MS": "audio",
    # 模型
    "FAST_LANE_TIMEOUT_MS": "wall",
    # TTS
    "MIAI_HTTP_KEEPALIVE_MS": "wall（连接空闲）",
    # 设备
    "MIAI_IDLE_TIMEOUT_MS": "wall",
    "PET_TICK_MS": "wall",
    "PET_MIC_OPEN_TIMEOUT_MS": "wall",
    "PET_LISTEN_MS": "wall",
    "PET_GREET_AWAY_MS": "wall",
    "PET_CHATTER_IDLE_MS": "wall",
    "MIAI_PHOTO_TIMEOUT_MS": "wall",
    "MIAI_CONFIRM_TIMEOUT_MS": "wall",
    "MIAI_HQ_ARM_TIMEOUT_MS": "wall",
    "MIAI_HQ_SHUTTER_TIMEOUT_MS": "wall",
    "MIAI_ANNOUNCE_MAX": "—（条数）",
    "MIAI_ARCHIVE_KEEP": "—（个数）",
    "MIAI_ARCHIVE_MAX_MB": "—（字节）",
    "KEEPALIVE_MINUTES": "wall",
    "MIAI_LEVEL_LOG": "wall（日志周期）",
    # 常量
    "CANCEL_GRACE_MS": "wall",
    "FORK_TIMEOUT_MS": "wall",
    "PLAYED_GRACE_MS": "wall",
    "PLAYBACK_POLL_MS": "wall",
    "ASSEMBLER_FALLBACK_WINDOW_MS": "wall",
    "ASSEMBLER_PREDICT_LEAD_MS": "audio",
    "ASSEMBLER_TRAILING_TRIM_MS": "audio",
    "INITIAL_LISTEN_MS": "wall",
    "CAPTURE_GRACE_MS": "wall",
    "HANDSHAKE_WAIT_MS": "wall",
    "PREWARM_TTL_MS": "wall",
    "DEFAULT_MAX_TURN_MS": "wall",
    "DEFAULT_MAX_STOP_TO_FIRST_MS": "wall",
    "DEFAULT_BARGE_STOP_WITHIN_MS": "wall",
    "RESOLUTION_MS": "wall",
    "DEFAULT_SENTENCE_SILENCE_MS": "audio",
    "DEFAULT_TIMEOUT_MS": "wall",
    "RECENT_MS": "wall",
    "PLAYBACK_TAIL_MS": "wall",
    # 以下几条是查过源码后补的
    "FIRST_WORD_BUDGET_MS": "wall",
    "WAITED_THRESHOLD_MS": "—（统计判据）",
    "SLOW_TURN_MS": "—（统计判据）",
    "TAIL_TTL_MS": "wall",
    "ANNOUNCE_QUIET_MS": "wall",
    "DEFAULT_KEEPALIVE_MS": "wall（连接空闲）",
    "DEFAULT_POLL_MS": "wall",
    "DEFAULT_CAPTURE_TIMEOUT_MS": "wall",
    "DEFAULT_CONFIRM_TIMEOUT_MS": "wall",
    "SUPERSEDED_TTL_MS": "wall",
}

#: 布尔开关没有「时钟」这个概念 —— 它们开关的是机制，不是时长
CLOCK_NA = "—（开关）"

#: 被谁遮住：这段等待有没有藏在别的串行环节后面
SHADED_BY: dict[str, str] = {
    "TURN_JUDGE_EXTEND_MS": "模型段（模型 >200 ms 时几乎全遮住；模型变快后变成纯成本）",
    "TURN_JUDGE_WAIT_BUDGET_MS": "同上 —— 200 是按「模型段 ~184 ms」定的，模型变慢要重算",
    "TURN_JUDGE_QUIET_MS": "模型段",
    "TURN_JUDGE_MAX_OPEN_SILENCE_MS": "无（它自己是上限）",
    "VOICE_PAUSE_DETECT_MS": "ASR 解出句之前（提前起跑，不额外等）",
    "VOICE_SPECULATE_MS": "同上（投机与 ASR 并行）",
    "PREWARM_TTL_MS": "定稿→开轮之间（正常 0–600 ms，用不完）",
    "ASSEMBLER_PREDICT_LEAD_MS": "ASR 出句之前",
    "PLAYBACK_POLL_MS": "设备播报期间（轮询，不加延迟）",
    # 查源码后补的
    "VOICE_PREROLL_MS": "无（它是滑窗长度，不加延迟）",
    "VOICE_HOLD_MS": "无（它决定 `gate.close` 何时落，① 的起点；配大了 ① 会被算小）",
    "QWEN_ASR_VAD_SILENCE_MS": "无（已关：`turn_detection: null`，端点由 `VOICE_COMMIT_MS` 控）",
    "TURN_JUDGE_TRIM_MS": "判停侧车输入预处理（不额外等）",
    "TURN_JUDGE_SEQUENCE_BUDGET_MS": "模型段（只对数字/字母/「然后」这类句尾生效）",
    "VOICE_COMMIT_MS": "无 —— 它就是封段的那一刻，实际门槛被上行包长盖住",
    "VOICE_OPEN_QUIET_MS": "ASR 已出句、等静音够了才开轮（**这段是纯等待**）",
    "VOICE_OPEN_QUIET_SHORT_MS": "同上（p ≥ 0.8 时走这条）",
    "ASSEMBLER_FALLBACK_WINDOW_MS": "ASR 出句之后（兜底，正常不触发）",
    "ASSEMBLER_TRAILING_TRIM_MS": "判停侧车输入预处理（不额外等）",
    "FIRST_WORD_BUDGET_MS": "无（它是报警线，不约束任何环节）",
    "FAST_LANE_TIMEOUT_MS": "模型段（它就是那一轮的上限）",
    # 统计判据：它们不约束任何环节，只决定报告怎么分组/计数
    "WAITED_THRESHOLD_MS": "无（报告分组门槛，不参与调度）",
    "SLOW_TURN_MS": "无（报告里的「慢轮」门槛）",
}

#: 上限：这条参数有没有硬顶
CAP: dict[str, str] = {
    "TURN_JUDGE_EXTEND_MS": "TURN_JUDGE_MAX_EXT 拍 / WAIT_BUDGET_MS 预算 / MAX_OPEN_SILENCE_MS",
    "TURN_JUDGE_MAX_EXT": "TURN_JUDGE_WAIT_BUDGET_MS",
    "TURN_JUDGE_MAX_UNSURE": "TURN_JUDGE_MAX_EXT（两条取小）",
    "VOICE_COMMIT_MS": "实际门槛 = 一整个上行包（75 ms），配置值被它盖住",
    "FAST_LANE_TIMEOUT_MS": "FAST_LANE > 0 时固定；超时转 dsh",
    "TURN_JUDGE_SEQUENCE_BUDGET_MS": "TURN_JUDGE_MAX_OPEN_SILENCE_MS",
}

#: 不在「停嘴 → 出声」路径上的。这些不是遗漏 —— 它们确实存在，但改它们不会动首声
#: 延迟，所以「被谁遮住」对它们没意义。列出来是为了**一眼分出「已判定无关」和
#: 「还没查」**，而不是让两者混在同一个「未标注」里。
NOT_ON_PATH = {
    "MIAI_IDLE_TIMEOUT_MS",
    "MIAI_PHOTO_TIMEOUT_MS",
    "MIAI_HQ_ARM_TIMEOUT_MS",
    "MIAI_HQ_SHUTTER_TIMEOUT_MS",
    "MIAI_CONFIRM_TIMEOUT_MS",
    "DEFAULT_CONFIRM_TIMEOUT_MS",
    "DEFAULT_CAPTURE_TIMEOUT_MS",
    "DEFAULT_KEEPALIVE_MS",
    "MIAI_ANNOUNCE_MAX",
    "MIAI_ARCHIVE_KEEP",
    "MIAI_ARCHIVE_MAX_MB",
    "MIAI_LEVEL_LOG",
    "PET_GREET_AWAY_MS",
    "PET_CHATTER_IDLE_MS",
    "PET_LISTEN_MS",
    "PET_MIC_OPEN_TIMEOUT_MS",
    "PET_TICK_MS",
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
    "DEFAULT_POLL_MS",
    "DEFAULT_SENTENCE_SILENCE_MS",
    "PLAYED_GRACE_MS",
    "PLAYBACK_POLL_MS",
    "KEEPALIVE_MINUTES",
    "FAST_LANE_SPECULATE",
    "FAST_LANE_PREFETCH",
    "FAST_LANE_PARTIAL_SPECULATE",
    "COSYVOICE_PREWARM",
}

ENV_RE = re.compile(r"envNumber\(\s*'([A-Z0-9_]+)'\s*,\s*(.+?)\)\s*[,)]")
CONST_RE = re.compile(
    r"^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*_(?:MS|MINUTES|POLL_MS|GRACE_MS))\s*=\s*(.+?);"
)
PROCESS_RE = re.compile(r"process\.env\['([A-Z0-9_]+)'\]\s*(!==|===)\s*'([^']*)'")


CONST_RE = re.compile(
    r"^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*_(?:MS|MINUTES|POLL_MS|GRACE_MS))\s*=\s*(.+?);"
)
PROCESS_RE = re.compile(r"process\.env\['([A-Z0-9_]+)'\]\s*(!==|===)\s*'([^']*)'")

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

            # 布尔开关（`!== '0'` 这类）也算「会改变时刻」的旋钮
            for m in PROCESS_RE.finditer(line):
                name = m.group(1)
                if name in seen_env or name not in TIMING_FLAGS:
                    continue
                # `?? 'x'` 写在表达式里时以它为准；否则 `!== '0'` 意味着「不设就是开」
                dm = re.search(re.escape(name) + r"'\]\s*\?\?\s*'([^']*)'", line)
                if dm is not None:
                    default = dm.group(1)
                else:
                    default = "1" if m.group(2) == "!==" else "0"
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
    return found


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
        "> 为什么要有这张表：项目里既有「配置写 20 ms、实际门槛 75 ms」这种**口径错位**，",
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

    table(env_knobs, "一、环境变量（`.env` 可调）", f"共 {len(env_knobs)} 项。")
    table(flag_knobs, "二、布尔开关（会改变时刻或路径）", f"共 {len(flag_knobs)} 项。")
    table(const_knobs, "三、硬编码常量（改要动代码）", f"共 {len(const_knobs)} 项。")

    unmarked_clock = [k.name for k in knobs if not k.clock]
    unmarked_shadow = [k.name for k in knobs if not k.shaded and k.clock not in ("—（条数）", "—（个数）", "—（字节）")]
    lines.append("## 四、还没标注的")
    lines.append("")
    lines.append("这些不是遗漏登记，是**还没查清**。填之前不要凭直觉写 —— 「时钟」写错")
    lines.append("比空着更糟，因为空着会被当成待办、写错会被当成结论。")
    lines.append("")
    lines.append(f"- 缺「时钟」：{'、'.join(f'`{n}`' for n in unmarked_clock) if unmarked_clock else '（无）'}")
    lines.append(f"- 缺「被谁遮住」：{'、'.join(f'`{n}`' for n in unmarked_shadow) if unmarked_shadow else '（无）'}")
    lines.append("")

    lines.append("## 五、两条从这张表里读出来的结论")
    lines.append("")
    lines.append("**1. `VOICE_COMMIT_MS` 的配置值从来没生效过。**")
    lines.append("")
    lines.append("它比的是墙上时间（`t - lastVoicedAt`），而**同一个包里尾部的静音帧不参与计时**。")
    lines.append("上行是 75 ms 一包，于是实际门槛是「一整个包的静音」—— 配置 20 和 40 的差别只在")
    lines.append("包边界上。这解释了为什么「40 改 20 省 20 ms」那条结论也是错的。")
    lines.append("")
    lines.append("**2. 判停的等待（`TURN_JUDGE_*`）现在是纯成本。**")
    lines.append("")
    lines.append("它原本被模型段（300–570 ms）遮住；保活修好、模型段回到 ~184 ms 之后，「被谁遮住」")
    lines.append("那一条就不再成立。所以 `WAIT_BUDGET_MS` 从 400 收到 200 —— 数字要跟着被遮住的")
    lines.append("那个环节一起重算，不能一次定死。")
    lines.append("")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="生成时间参数总表")
    ap.add_argument("--write", action="store_true", help="写回 docs/TIME-KNOBS.md")
    ap.add_argument("--prod", type=Path, default=None, help="与线上 .env 对照（标出默认值差异）")
    args = ap.parse_args(argv)

    knobs = scan()
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
