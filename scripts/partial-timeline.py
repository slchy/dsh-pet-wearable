# -*- coding: utf-8 -*-
"""中间结果（asr.partial）时间线。

三个口径，都要，因为它们回答不同的问题：

- `online`  —— 线上 `acceptsSpeculation` 的等价实现（去**尾**标点 + 严格前缀 +
              覆盖 ≥0.6 + 数字不截断）。这是**真的能认领**的那一版，收益上限由它决定。
- `strict`  —— 去**全部**标点后仍是定稿前缀的覆盖率。用来分辨「0% 是标点假象」还是真的没到。
- `lcp`     —— 去全部标点后的最长公共前缀覆盖率。衡量「信息上已经知道了多少」，
              不受「ASR 中途改了一个字就整条作废」影响，是这条路的信息上限。

门槛看三个：60%（线上门槛）/ 90%（接近完整）/ 100%（完全一致）。
**未达标的轮次留在分母里**，不参与中位但计入「n/N」。
"""
import json
import os
import re
import statistics
import sys
from pathlib import Path

# ---- 线上 `stripPartialTail`（只去尾部） ----
TAIL_PUNCT = re.compile(r"[\s，,。.、；;：:？?！!…～~]+$")
# ---- 去全部标点：中英标点 + 空白 ----
ALL_PUNCT = re.compile(
    r"[\s，,。.、；;：:？?！!…～~“”\"'‘’（）()《》〈〉【】\[\]{}—－\-·、/\\|]"
)
# ---- 线上 `NUMERIC_CHAR` ----
NUMERIC_CHAR = re.compile(r"[0-9０-９零一二三四五六七八九十百千万两]")
# ---- 线上常量（快车道当前配置） ----
SPEC_MIN_CHARS = 6
SPEC_MIN_COVERAGE = 0.6
# 线上 `VOICE_SPECULATE_MS` 默认值：静音满这么久才交出中间结果
SPECULATE_MS = 100


def strip_tail(s: str) -> str:
    return TAIL_PUNCT.sub("", s)


def norm(s: str) -> str:
    return ALL_PUNCT.sub("", s)


def accepts_speculation(spec: str, final: str) -> bool:
    """与 `src/fronted-agent.ts:acceptsSpeculation` 等价。"""
    s = strip_tail(spec)
    if len(s) < SPEC_MIN_CHARS:
        return False
    if not final.startswith(s):
        return False
    if len(s) < len(final) * SPEC_MIN_COVERAGE:
        return False
    tail = final[len(s):]
    if tail and NUMERIC_CHAR.match(s[-1]) and NUMERIC_CHAR.match(tail[0]):
        return False
    return True


def strict_cov(spec: str, final_n: str) -> float:
    """去全部标点后的严格前缀覆盖率；破坏前缀记 0。"""
    s = norm(spec)
    if not s:
        return 0.0
    if not final_n.startswith(s):
        return 0.0
    return len(s) / len(final_n)


def lcp_cov(spec: str, final_n: str) -> float:
    s = norm(spec)
    n = min(len(s), len(final_n))
    i = 0
    while i < n and s[i] == final_n[i]:
        i += 1
    return i / len(final_n)


def load(path: Path):
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def speech_stop_at(events, gate_idx):
    """线上 `speechStopAt`：`gate.close.t - gapMs`。"""
    if gate_idx is None:
        return None
    e = events[gate_idx]
    gap = e.get("gapMs")
    return e["t"] - int(gap) if gap is not None else e["t"]


def analyze(path: Path):
    events = load(path)
    starts = [i for i, e in enumerate(events) if e.get("ev") == "turn.start"]
    sents = [i for i, e in enumerate(events) if e.get("ev") == "asr.sentence"]
    gates = [i for i, e in enumerate(events) if e.get("ev") == "gate.close"]
    used_gate = set()
    prev_sent_idx = -1
    rows = []
    for n, at in enumerate(starts):
        prev_at = -1 if n == 0 else starts[n - 1]
        next_at = starts[n + 1] if n + 1 < len(starts) else len(events)

        # 本轮定稿：turn.start 之前最近的 asr.sentence
        sent_idx = -1
        for i in range(at - 1, prev_at, -1):
            if events[i].get("ev") == "asr.sentence":
                sent_idx = i
                break
        if sent_idx < 0:
            continue
        sent = events[sent_idx]
        final = sent["text"]
        final_n = norm(final)
        if not final_n:
            continue

        # 停嘴时刻：定稿往后找第一个未用的 gate.close
        gate_idx = None
        for i in range(sent_idx, next_at):
            if events[i].get("ev") == "gate.close" and i not in used_gate:
                gate_idx = i
                used_gate.add(i)
                break
        stop = speech_stop_at(events, gate_idx)

        # 本轮的 partial：前一个定稿之后、本轮定稿之前（含）
        window = [
            (i, events[i])
            for i in range(prev_sent_idx + 1, sent_idx)
            if events[i].get("ev") == "asr.partial"
        ]
        prev_sent_idx = sent_idx

        # 首达各门槛的时刻
        def first_at(pred, after=None):
            for _, p in window:
                if after is not None and p["t"] <= after:
                    continue
                if pred(p["text"]):
                    return p["t"]
            return None

        t60 = first_at(lambda s: accepts_speculation(s, final))
        t90 = first_at(lambda s: strict_cov(s, final_n) >= 0.9)
        t100 = first_at(lambda s: strict_cov(s, final_n) >= 1.0)
        # 「短句只在完全一致时认领」：门槛降到 2 字，但要求去标点后与定稿完全相同
        t_exact2 = first_at(
            lambda s: len(norm(s)) >= 2 and strict_cov(s, final_n) >= 1.0
        )

        # 现在这条路径实际能拿到的提前量：
        # `maybeSpeculate` 只在静音满 100 ms 的那个 tick 问一次，那一刻可认领就有，否则整轮没有。
        # 所以现在是「定稿 - max(停嘴+100, 首次可认领)」，且必须是首次可认领早于停嘴+100。
        tick = None if stop is None else stop + SPECULATE_MS
        now = None
        retry = None
        if tick is not None:
            if t60 is not None and t60 <= tick:
                now = sent["t"] - tick
            if t60 is not None:
                retry = sent["t"] - max(tick, t60)
            else:
                retry = 0

        # 停嘴 +100 ms 时已经拿到了什么。
        # 「一条 partial 都还没有」和「有 partial 但覆盖 0」是两件事，分开记 ——
        # 前者是 ASR 还没吐第一个中间结果，后者是吐了但对不上定稿。
        cov_strict_100 = cov_lcp_100 = None
        silent_100 = False
        if stop is not None:
            upto = [p for _, p in window if p["t"] <= stop + 100]
            if upto:
                cov_strict_100 = max(strict_cov(p["text"], final_n) for p in upto)
                cov_lcp_100 = max(lcp_cov(p["text"], final_n) for p in upto)
            else:
                cov_strict_100 = cov_lcp_100 = 0.0
                silent_100 = True

        rows.append(
            dict(
                n=n + 1,
                chars=len(final_n),
                final=final,
                silence=sent["t"] - stop if stop is not None else None,
                cov_strict_100=cov_strict_100,
                cov_lcp_100=cov_lcp_100,
                silent_100=silent_100,
                partial_ok_100=(
                    None if cov_strict_100 is None else cov_strict_100 >= 0.9
                ),
                early60=None if t60 is None else sent["t"] - t60,
                early90=None if t90 is None else sent["t"] - t90,
                early100=None if t100 is None else sent["t"] - t100,
                early_exact2=None if t_exact2 is None else sent["t"] - t_exact2,
                now=now,
                retry=retry,
                n_partial=len(window),
            )
        )
    return rows


def fmt(v):
    return "  —" if v is None else f"{v:4d}"


def pct(v):
    return "  —" if v is None else f"{v*100:3.0f}%"


def report(name, rows):
    print(f"\n{'='*100}\n{name}   n={len(rows)}\n{'='*100}")
    print(f"{'轮':>3} {'字':>3} {'停→稿':>6} {'+100覆盖':>9} {'+100lcp':>8} "
          f"{'提前60':>7} {'提前90':>7} {'提前100':>8} {'现拿到':>7} {'重试后':>7}  定稿")
    for r in rows:
        print(
            f"{r['n']:>3} {r['chars']:>3} {fmt(r['silence']):>6} "
            f"{pct(r['cov_strict_100']):>9} {pct(r['cov_lcp_100']):>8} "
            f"{fmt(r['early60']):>7} {fmt(r['early90']):>7} {fmt(r['early100']):>8} "
            f"{fmt(r['now']):>7} {fmt(r['retry']):>7}  "
            f"{r['final']}"
        )

    def line(label, vals):
        hit = [v for v in vals if v is not None]
        if not hit:
            print(f"  {label:<26} 达标 0/{len(vals)}")
            return
        hit.sort()
        med = statistics.median(hit)
        p90 = hit[min(len(hit) - 1, int(round(0.9 * (len(hit) - 1))))]
        print(
            f"  {label:<26} 达标 {len(hit):>2}/{len(vals):<2}  "
            f"中位 {med:>4.0f}  p90 {p90:>4}  max {hit[-1]:>4}  "
            f"（未达标记 0 的中位 {statistics.median([v or 0 for v in vals]):>4.0f}）"
        )

    print()
    line("提前量 60%（线上可认领）", [r["early60"] for r in rows])
    line("提前量 90%（接近完整）", [r["early90"] for r in rows])
    line("提前量 100%（完全一致）", [r["early100"] for r in rows])
    line("提前量 完全一致·门槛降到2", [r["early_exact2"] for r in rows])

    # 「只问一次」vs「每 tick 都问」—— 这两行是「记账顺序该不该修」的判据，
    # 不能预设修了不影响行为。
    n = len(rows)
    now_hit = [r["now"] for r in rows if r["now"] is not None]
    retry_hit = [r["retry"] for r in rows if (r["retry"] or 0) > 0]
    print(
        f"  投机能起跑的轮次            现在 {len(now_hit):>2}/{n:<2}"
        f"  每 tick 重试 {len(retry_hit):>2}/{n:<2}"
    )
    if now_hit:
        print(f"    现在能拿到   中位 {statistics.median(now_hit):>4.0f}  "
              f"max {max(now_hit):>4}")
    if retry_hit:
        print(f"    重试后能拿到 中位 {statistics.median(retry_hit):>4.0f}  "
              f"max {max(retry_hit):>4}")
    ss = [r["cov_strict_100"] for r in rows if r["cov_strict_100"] is not None]
    ll = [r["cov_lcp_100"] for r in rows if r["cov_lcp_100"] is not None]
    if ss:
        silent = sum(1 for r in rows if r["silent_100"])
        print(
            f"  停嘴+100 覆盖  严格前缀中位 {statistics.median(ss)*100:>3.0f}%  "
            f"lcp 中位 {statistics.median(ll)*100:>3.0f}%   "
            f"（0% 的轮次：严格 {sum(1 for v in ss if v==0)}/{len(ss)}，"
            f"其中「一条 partial 都还没到」{silent} 轮）"
        )
        ok = [r["partial_ok_100"] for r in rows if r["partial_ok_100"] is not None]
        if ok:
            print(
                f"  停嘴+100 已接近完整(≥90%)   {sum(ok)}/{len(ok)} 轮"
                f"   —— 短句（≤6 字）里 {sum(1 for r in rows if r['chars'] <= 6 and r['partial_ok_100'])}/"
                f"{sum(1 for r in rows if r['chars'] <= 6 and r['partial_ok_100'] is not None)}"
            )
    # 按句长分组
    print("\n  按句长分组（短 ≤6 / 中 7–12 / 长 ≥13）")
    for label, lo, hi in (("短", 0, 6), ("中", 7, 12), ("长", 13, 999)):
        g = [r for r in rows if lo <= r["chars"] <= hi]
        if not g:
            continue
        e60 = [r["early60"] for r in g]
        e90 = [r["early90"] for r in g]
        h60 = sorted(v for v in e60 if v is not None)
        h90 = sorted(v for v in e90 if v is not None)
        c100 = [r["cov_strict_100"] for r in g if r["cov_strict_100"] is not None]
        med60 = f"{statistics.median(h60):>3.0f}" if h60 else "  —"
        med90 = f"{statistics.median(h90):>3.0f}" if h90 else "  —"
        print(
            f"    {label} n={len(g):>2}  提前60 {len(h60)}/{len(g)} 中位 {med60}"
            f"   提前90 {len(h90)}/{len(g)} 中位 {med90}"
            + (
                f"   +100覆盖 中位 {statistics.median(c100)*100:>3.0f}%"
                if c100
                else ""
            )
        )
    return rows


def dump(path: Path):
    """打印每一轮的 partial 演化，人工核对「60% 的 partial 长什么样」。"""
    events = load(path)
    starts = [i for i, e in enumerate(events) if e.get("ev") == "turn.start"]
    prev_sent = -1
    for n, at in enumerate(starts):
        prev_at = -1 if n == 0 else starts[n - 1]
        sent_idx = -1
        for i in range(at - 1, prev_at, -1):
            if events[i].get("ev") == "asr.sentence":
                sent_idx = i
                break
        if sent_idx < 0:
            continue
        final = events[sent_idx]["text"]
        final_n = norm(final)
        window = [
            events[i]
            for i in range(prev_sent + 1, sent_idx)
            if events[i].get("ev") == "asr.partial"
        ]
        prev_sent = sent_idx
        if not window:
            continue
        t_sent = events[sent_idx]["t"]
        print(f"\n--- 轮 {n + 1}  定稿 @{t_sent}  {final}")
        last = None
        for p in window:
            if p["text"] == last:
                continue
            last = p["text"]
            print(
                f"   {p['t'] - t_sent:>+7}ms  cov {strict_cov(p['text'], final_n)*100:>3.0f}%"
                f"  {'ACCEPT' if accepts_speculation(p['text'], final) else '      '}"
                f"  {p['text']}"
            )



def analyze_asks(path: Path):
    """**实际发出账**：从 `agent.ask` 读，不靠推算。

    上面那张表算的是「理论上多早可以发」，这里算的是「真的多早发了」。

    - `spec` 是中间结果投机（定稿前），`prefetch` 是定稿那一刻起跑（提前量必然≈0）；
    - 提前量 = `asr.sentence.t - agent.ask.t`，**这就是验收该看的第一个数**；
    - 认领看 `agent.claim`（`ok:true`）落在本轮窗口里没有，`ran_for_ms` 是认领时
      已经跑掉多少 —— 但它会被判停等待撑大，只当参考、不当指标。
    """
    events = load(path)
    starts = [i for i, e in enumerate(events) if e.get("ev") == "turn.start"]
    rows = []
    for n, at in enumerate(starts):
        prev_at = -1 if n == 0 else starts[n - 1]
        next_at = starts[n + 1] if n + 1 < len(starts) else len(events)
        sent_idx = -1
        for i in range(at - 1, prev_at, -1):
            if events[i].get("ev") == "asr.sentence":
                sent_idx = i
                break
        if sent_idx < 0:
            continue
        sent = events[sent_idx]

        # 本轮的投机一定落在「上一轮开轮」到「本轮定稿」之间 —— 用下一轮的开轮当
        # 上界会把下一轮的投机算进来（会算出 -16 s 那种负提前量）。
        spec = None
        for i in range(prev_at + 1, sent_idx + 1):
            e = events[i]
            if e.get("ev") == "agent.ask" and e.get("t", 0) <= sent["t"]:
                spec = e
        claim = None
        drop_why = None
        for i in range(sent_idx, next_at):
            e = events[i]
            if e.get("t", 0) < sent["t"]:
                continue
            if e.get("ev") == "agent.claim" and e.get("ok") is True and claim is None:
                claim = e
            if e.get("ev") == "agent.drop" and drop_why is None:
                drop_why = e.get("why")
        rows.append(
            dict(
                n=n + 1,
                final=sent["text"],
                kind=None if spec is None else spec.get("kind"),
                spec=None if spec is None else spec["text"],
                early=None if spec is None else sent["t"] - spec["t"],
                claimed=claim is not None,
                ran=claim.get("ran_for_ms") if claim is not None else None,
                drop=drop_why,
            )
        )
    return rows


def report_asks(name, rows):
    print(f"\n{'-'*100}\n{name} 实际发出账  n={len(rows)}\n{'-'*100}")
    print(f"{'轮':>3} {'提前':>6} {'认领':>4} {'已跑':>6}  kind      投机文本 → 定稿（缺的字在末尾）")
    for r in rows:
        print(
            f"{r['n']:>3} {fmt(r['early']):>6} {'✓' if r['claimed'] else '✗':>4} "
            f"{'—' if r['ran'] is None else round(r['ran']):>6}  "
            f"{r['kind'] or '—':<9} "
            f"{r['spec'] or '（定稿前没发出去）'}"
            + (f"  →  {r['final']}" if r["spec"] and r["spec"] != r["final"] else "")
        )
    spec_rows = [r for r in rows if r["early"] is not None]
    early = sorted(r["early"] for r in spec_rows)
    if early:
        print(
            f"\n  spec 发出 {len(early)}/{len(rows)} 轮   提前量 中位 {statistics.median(early):>4.0f}"
            f"  p90 {early[min(len(early)-1, int(round(0.9*(len(early)-1))))]:>4}  max {early[-1]:>4}"
        )
    claimed = sum(1 for r in spec_rows if r["claimed"])
    print(f"  认领 {claimed}/{len(spec_rows)}" + ("  （没有 spec 轮次）" if not spec_rows else ""))


def main():
    # 用法：
    #   python scripts/partial-timeline.py                 # 跑 tmp/ 下那四场
    #   python scripts/partial-timeline.py arch071340 …    # 只跑指定的
    #   python scripts/partial-timeline.py --dump arch071340   # 逐轮打 partial 演化
    #   python scripts/partial-timeline.py --asks arch071340   # 只出「实际发出账」
    #   MIAI_ARCH_DIR=<别的目录> python scripts/partial-timeline.py
    base = Path(os.environ.get("MIAI_ARCH_DIR") or Path(__file__).parent.parent / "tmp")
    args = sys.argv[1:]
    if args and args[0] == "--dump":
        for name in args[1:] or ["arch071340"]:
            p = base / name / "events.jsonl"
            print(f"\n########## {name} ##########")
            dump(p)
        return
    only_asks = bool(args) and args[0] == "--asks"
    if only_asks:
        args = args[1:]
    targets = args or ["arch071340", "arch080409", "arch081608", "arch094025"]
    if only_asks:
        for name in targets:
            p = base / name / "events.jsonl"
            if not p.exists():
                print(f"跳过 {name}：没有 events.jsonl")
                continue
            report_asks(name, analyze_asks(p))
        return
    allrows = {}
    for name in targets:
        p = base / name / "events.jsonl"
        if not p.exists():
            print(f"跳过 {name}：没有 events.jsonl")
            continue
        allrows[name] = report(name, analyze(p))
        report_asks(name, analyze_asks(p))

    if len(allrows) > 1:
        print(f"\n{'='*100}\n各场合计\n{'='*100}")
        for label, key in (
            ("提前量 60%", "early60"),
            ("提前量 90%", "early90"),
            ("提前量 100%", "early100"),
        ):
            vals = [r[key] for rs in allrows.values() for r in rs]
            hit = sorted(v for v in vals if v is not None)
            if hit:
                print(
                    f"  {label:<14} 达标 {len(hit):>2}/{len(vals):<2}  "
                    f"中位 {statistics.median(hit):>4.0f}  max {hit[-1]:>4}"
                )


if __name__ == "__main__":
    main()
