"""用现有真机档案离线重放**新**的判停策略，和线上实际发生的事逐轮对比。

## 为什么要重放而不是等新数据

新逻辑只会**更早**收下（删掉 grace / unfinished 两条分支 + 加一条统一上限），
所以它每一个决定都发生在档案里已有的事件点上 —— 拿记录的 `judge.decide` 轨迹
顺序扫描，第一个判「收下」的事件就是新的开轮时刻。不需要重新跑模型、不需要
真机、结果可复算。

## 口径

`② = 开轮 − 定稿`：定稿取该轮**第一句** `asr.sentence` / `userFinal` 的时刻，
开轮取 `turn.start`。首声 `= tts.first − turn.start`（即 ③）。

新首声 = 旧首声 − Δ②（假定 ③ 不受影响 —— 快车道在等判停期间已经在跑，
所以这个假定偏向保守：真机上 ③ 只会因为多等而更长，不会因为少等而更长）。

## 复放的新规则（对应 `src/utterance-assembler.ts::evaluate`）

1. 统一上限：静音 ≥ `--cap-ms` → 收下（`whyAccept=cap`），任何分支都不许绕过
2. 静音闸门：静音 < 门槛 → 加一拍（`why=silence`）
3. 短碎片：拍数为 0 且文本 ≤ 3 字且紧跟上一轮 → 加一拍（`why=short`）
4. 收下：`p ≥ 阈值` / 拍数用满 / 预算用完 / unsure 拍数用满
5. 其余：加一拍（`why=unsure`）

**没有建模的**：`unchanged`（快照字节没变就不再等）。真机噪声底约 −69 dBFS，
高于裁静音门限（−60 post-gain = −72 pre-gain），所以尾巴**裁不掉**、
快照一直在长 —— 线上那条捷径基本不触发（否则静音不会攒到 800 ms）。
不复现它 → 新 ② 偏长，是保守方向。`short` 需要的 `lastUtteranceAt` 用上一轮
`turn.start` 近似。

用法：
    python bench/eot/policy_replay.py --arch-root tmp/arch --out tmp/policy-probe/replay.json
    python bench/eot/policy_replay.py --arch-root tmp/arch --out ... --cap-ms 0
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re

import numpy as np

from turn_open_probe import (
    BYTES_PER_SEC,
    FRAME,
    FRAME_MS,
    frame_peak_dbfs,
    load_events,
    text_of,
    voiced_mask,
)

# `src/utterance-assembler.ts::looksUnfinished` 的正则与 `stripTail`
_TRAILING_PUNCT = re.compile(r"[\s。．.，,、!！?？~～…\-—:：;；\"'“”‘’]+$")
_UNFINISHED_TAIL = re.compile(
    r"(?:[0-9０-９]|[零一二三四五六七八九十百千万亿两]|[A-Za-z#＃]|井号|第|和|跟|与|及|还有|就是|因为|所以|但是|然后|如果|的话|或者|还是)$"
)
_SHORT_STRIP = re.compile(r"[\s。.,，!！?？、~～…\-—]")


def looks_unfinished(text: str) -> bool:
    core = _TRAILING_PUNCT.sub("", text)
    return bool(core) and bool(_UNFINISHED_TAIL.search(core))


def dedupe_speech(events: list[dict]) -> list[dict]:
    """`asr.sentence` 与 `pet.in/userFinal` 是同一句话的两份记录（相隔 1–70 ms）。

    不去重的话「用户又说了」会被算两遍 —— 表里那些 +4 ms / +72 ms 的"再说一句"
    全是这个，不是真的接着说。
    """
    out: list[dict] = []
    for e in sorted(events, key=lambda x: x["t"]):
        text = text_of(e)
        dup = any(text_of(p) == text and 0 <= e["t"] - p["t"] <= 100 for p in out[-3:])
        if text and dup:
            continue
        out.append(e)
    return out


def silence_at(voiced: np.ndarray, byte_off: float) -> float | None:
    """该 PCM 偏移处已经连续静音多久（ms）。和 `turn_open_probe` 的量 A 同一口径。"""
    if not voiced.size or not isinstance(byte_off, (int, float)):
        return None
    fr = int(min(max(byte_off / (FRAME * 2), 0), voiced.size - 1))
    idx = np.flatnonzero(voiced[: fr + 1])
    if not idx.size:
        return None
    return float((fr - int(idx[-1])) * FRAME_MS)


def replay_turn(decides: list[dict], voiced: np.ndarray, text: str, prev_start: float, cfg: dict) -> dict:
    """在一轮的 decide 轨迹上跑新规则，返回新开轮时刻与每个决定。"""
    extensions = 0
    unsure = 0
    waited = 0
    budget = cfg["sequence_budget"] if looks_unfinished(text) else cfg["budget"]
    trace = []
    for e in decides:
        p = float(e.get("p", -1))
        thr = float(e.get("threshold", cfg["threshold"]))
        sil = silence_at(voiced, (e.get("at") or {}).get("pcm"))
        open_quiet = cfg["open_quiet_high"] if p >= 0.8 else cfg["open_quiet"]
        step = {
            "t": e["t"], "p": round(p, 3), "threshold": thr,
            "silence_ms": None if sil is None else round(sil), "action": None, "why": None,
        }

        over_budget = budget > 0 and waited >= budget
        # 1. 统一上限（谁都不能绕过）
        if cfg["cap"] > 0 and sil is not None and sil >= cfg["cap"]:
            step["action"], step["why"] = "accept", "cap"
            trace.append(step)
            return {"accept_t": e["t"], "trace": trace, "extensions": extensions, "waited": waited}
        # 2. 静音闸门（原实现里它在预算判断之前 return，现已被 `!overBudget()` 封住）
        if open_quiet > 0 and sil is not None and sil < open_quiet and extensions < cfg["max_ext"] and not over_budget:
            wait = max(1, min(open_quiet - sil, cfg["extend"]))
            extensions += 1
            waited += wait
            step.update(action="extend", why="silence", wait_ms=round(wait))
            trace.append(step)
            continue
        # 3. 短碎片（只在还没等过时生效，见 `shouldWaitForMore`）
        core = _SHORT_STRIP.sub("", text)
        if (extensions == 0 and not over_budget and 0 < len(core) <= 3
                and e["t"] - prev_start <= cfg["short_window"]):
            wait = min(cfg["extend"], cfg["short_wait"])
            extensions += 1
            waited += wait
            step.update(action="extend", why="short", wait_ms=round(wait))
            trace.append(step)
            continue
        # 4. 收下
        if p >= thr or extensions >= cfg["max_ext"] or over_budget or unsure >= cfg["max_unsure"]:
            step["action"], step["why"] = "accept", "rule"
            trace.append(step)
            return {"accept_t": e["t"], "trace": trace, "extensions": extensions, "waited": waited}
        # 5. 没说完，再等一拍
        extensions += 1
        unsure += 1
        waited += cfg["extend"]
        step.update(action="extend", why="unsure", wait_ms=cfg["extend"])
        trace.append(step)

    return {"accept_t": None, "trace": trace, "extensions": extensions, "waited": waited}


def analyse_session(dir_path: str, cfg: dict, floor_db: float) -> dict:
    ev = load_events(os.path.join(dir_path, "events.jsonl"))
    mic_gain = 1.0
    meta_path = os.path.join(dir_path, "meta.json")
    if os.path.exists(meta_path):
        try:
            meta = json.load(open(meta_path, encoding="utf-8"))
            gain = meta.get("micGain")
            gate = meta.get("gateDbfs")
            if isinstance(gain, (int, float)) and gain > 0:
                mic_gain = float(gain)
            if isinstance(gate, (int, float)):
                floor_db = float(gate)
        except json.JSONDecodeError:
            pass
    floor_pre = floor_db - 20.0 * np.log10(mic_gain)

    pcm_path = os.path.join(dir_path, "uplink.pcm")
    raw = np.fromfile(pcm_path, dtype="<i2") if os.path.exists(pcm_path) else np.zeros(0, dtype=np.int16)
    voiced = voiced_mask(frame_peak_dbfs(raw), floor_pre) if raw.size else np.zeros(0, dtype=bool)

    starts = [e for e in ev if e.get("ev") == "turn.start"]
    tts = [e for e in ev if e.get("ev") == "tts.first"]
    llm = [e for e in ev if e.get("ev") == "llm.first"]
    ends = [e for e in ev if e.get("ev") == "turn.end"]
    speech = dedupe_speech([e for e in ev if e.get("ev") == "asr.sentence"
                            or (e.get("ev") == "pet.in" and e.get("kind") == "userFinal")])
    decides = [e for e in ev if e.get("ev") == "judge.decide"]

    rows = []
    prev_start = float("-inf")
    for i, st in enumerate(starts):
        t0 = st["t"]
        nxt = starts[i + 1]["t"] if i + 1 < len(starts) else float("inf")
        in_turn = [e for e in speech if prev_start < e["t"] <= t0]
        fin = in_turn[0] if in_turn else None
        fin_t = fin["t"] if fin else None
        own = ""
        for e in reversed(in_turn):
            if text_of(e):
                own = text_of(e)
                break
        my_decides = [e for e in decides if fin_t is not None and fin_t <= e["t"] < t0]
        res = replay_turn(my_decides, voiced, own, prev_start, cfg) if my_decides else {"accept_t": None, "trace": []}
        new_accept = res["accept_t"] if res["accept_t"] is not None else t0

        tf = next((e for e in tts if t0 < e["t"] < nxt), None)
        lf = next((e for e in llm if t0 <= e["t"] < nxt), None)
        en = next((e for e in ends if t0 < e["t"] < nxt), None)
        # 「开轮后用户接着说」：照抄 turn_open_probe 的 ≤1500 ms 判据（**只在挑选时用**，
        # 之后重算结局不再看窗口 —— 窗口是「这句话算不算同一口气」的属性，不该跟着
        # 开轮时刻一起挪）
        resume = next((e for e in speech if t0 < e["t"] < nxt and e["t"] - t0 <= 1500), None)

        gap_old = None if fin_t is None else t0 - fin_t
        gap_new = None if fin_t is None else new_accept - fin_t
        first_old = None if tf is None else tf["t"] - t0
        delta = 0 if gap_old is None else (gap_old - gap_new)

        # **能省多少，取决于 ② 里有多少本来就藏在 agent 后面**。档案里 `llm.first`
        # 是「回复拿到手」的时刻（真正开始生成到拿到手，隔几百毫秒），所以：
        #   llm.first ≈ 开轮（≤20 ms）→ 回复在等待期间就好了、被 accept 卡住 → ② 暴露
        #   llm.first ≫ 开轮            → agent 本身就是瓶颈 → ② 藏在里面，早开轮不省
        fin2llm = None if (fin_t is None or lf is None) else lf["t"] - fin_t
        tts_delay = None if (lf is None or tf is None) else tf["t"] - lf["t"]
        total_old = None if (fin_t is None or tf is None) else tf["t"] - fin_t
        if fin2llm is None:
            exposure = "unknown"
        elif fin2llm - gap_old <= 20:
            exposure = "flush"
        else:
            exposure = "agent-bound"
        # 乐观：② 全部暴露在关键路径上（截掉多少就省多少），但不会低于 tts_delay
        total_opt = None
        if total_old is not None:
            floor = tts_delay if tts_delay is not None else 0
            total_opt = max(total_old - delta, floor)

        def outcome(first_abs: float | None) -> str | None:
            if tf is None:
                return "无 tts.first"
            if resume is None:
                return "未继续说"
            if resume["t"] < first_abs:
                return "a 出声前被吸收"
            if (en or {}).get("interrupted") is True:
                return "b 已出声被打断"
            return "c 半句当整句答"

        # 误切清点按**乐观前移量**算：开轮越早，被切的风险越大 —— 这是最坏情况
        new_start_abs = t0 - delta
        new_first_abs = None if tf is None else tf["t"] - delta
        old_out = outcome(None if tf is None else tf["t"])
        new_out = outcome(new_first_abs)
        # 旧逻辑在等待期间吸收掉、而新逻辑会在它之前就放行的那段话
        absorbed = [e["t"] for e in speech
                    if fin_t is not None and fin_t < e["t"] < t0]
        lost = [t for t in absorbed if t > new_accept]
        # 砍掉的那些再分两类：出声前被吸收 = 没伤害；出声后 = 真的会被打断/抢话
        lost_after_audio = [t for t in lost if new_first_abs is not None and t > new_first_abs]
        lost_before_audio = [t for t in lost if new_first_abs is not None and t <= new_first_abs]
        lost_unknown = [t for t in lost if new_first_abs is None]

        rows.append({
            "turn": i + 1,
            "text": own,
            "path": (en or {}).get("path"),
            "n_decides": len(my_decides),
            "gap_old_ms": None if gap_old is None else round(gap_old),
            "gap_new_ms": None if gap_new is None else round(gap_new),
            "delta_ms": round(delta),
            "first_old_ms": None if first_old is None else round(first_old),
            "fin2llm_ms": None if fin2llm is None else round(fin2llm),
            "tts_delay_ms": None if tts_delay is None else round(tts_delay),
            "total_old_ms": None if total_old is None else round(total_old),
            "total_opt_ms": None if total_opt is None else round(total_opt),
            "exposure": exposure,
            "resume_after_start_ms": None if resume is None else round(resume["t"] - t0),
            "interrupted": (en or {}).get("interrupted"),
            "outcome_old": old_out,
            "outcome_new": new_out,
            "absorbed_speeches": len(absorbed),
            "lost_speeches": len(lost),
            "lost_after_audio": len(lost_after_audio),
            "lost_before_audio": len(lost_before_audio),
            "lost_unknown": len(lost_unknown),
            # 清点用：每段被旧等待吸收的话，相对**定稿**的时刻，以及新策略下放行/出声的位置
            "absorbed_at_ms": [round(t - fin_t) for t in absorbed] if fin_t is not None else [],
            "new_accept_at_ms": None if fin_t is None else round(new_accept - fin_t),
            "new_audio_at_ms": None if (fin_t is None or tf is None) else round(tf["t"] - delta - fin_t),
            "new_trace": res["trace"],
        })
        prev_start = t0

    return {"session": os.path.basename(dir_path), "mic_gain": mic_gain, "n_turns": len(rows), "rows": rows}


def pct(values: list[float], q: float) -> float | None:
    return None if not values else float(np.percentile(values, q))


def summarise(rows: list[dict]) -> dict:
    gaps_old = [r["gap_old_ms"] for r in rows if r["gap_old_ms"] is not None]
    gaps_new = [r["gap_new_ms"] for r in rows if r["gap_new_ms"] is not None]
    # 主指标是「定稿 → 首声」的总时长（= ② + ③，也就是「说完到出声」里判停能碰的那一半）
    tot_old = [r["total_old_ms"] for r in rows if r["total_old_ms"] is not None]
    tot_opt = [r["total_opt_ms"] for r in rows if r["total_opt_ms"] is not None]
    by_exposure: dict[str, int] = {}
    for r in rows:
        by_exposure[r["exposure"]] = by_exposure.get(r["exposure"], 0) + 1
    return {
        "n_turns": len(rows),
        "gap_old": {"p50": pct(gaps_old, 50), "p90": pct(gaps_old, 90), "max": max(gaps_old) if gaps_old else None},
        "gap_new": {"p50": pct(gaps_new, 50), "p90": pct(gaps_new, 90), "max": max(gaps_new) if gaps_new else None},
        "total_old": {
            "n": len(tot_old), "p50": pct(tot_old, 50), "p90": pct(tot_old, 90),
            "max": max(tot_old) if tot_old else None,
            "gt_1500": sum(1 for v in tot_old if v > 1500),
        },
        "total_opt": {
            "n": len(tot_opt), "p50": pct(tot_opt, 50), "p90": pct(tot_opt, 90),
            "max": max(tot_opt) if tot_opt else None,
            "gt_1500": sum(1 for v in tot_opt if v > 1500),
        },
        "exposure": by_exposure,
        "turns_changed": sum(1 for r in rows if r["delta_ms"] > 0),
        "delta_sum_ms": sum(r["delta_ms"] for r in rows),
        "speeches_absorbed": sum(r["absorbed_speeches"] for r in rows),
        "speeches_lost": sum(r["lost_speeches"] for r in rows),
        # 砍掉之后**真的**会打断的三类：出声前被吸收（无害）、出声后（真伤害）、无声表（未知）
        "lost_before_audio": sum(r["lost_before_audio"] for r in rows),
        "lost_after_audio": sum(r["lost_after_audio"] for r in rows),
        "lost_unknown": sum(r["lost_unknown"] for r in rows),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch-root", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--floor-db", type=float, default=-40.0)
    # 线上实际部署的旋钮（`.env`）；改过的都留成参数好做敏感性
    ap.add_argument("--extend-ms", type=int, default=400)
    ap.add_argument("--max-ext", type=int, default=2)
    ap.add_argument("--max-unsure", type=int, default=1)
    ap.add_argument("--budget-ms", type=int, default=400)
    ap.add_argument("--sequence-budget-ms", type=int, default=1200)
    ap.add_argument("--open-quiet-ms", type=int, default=300)
    ap.add_argument("--open-quiet-high-ms", type=int, default=200)
    ap.add_argument("--short-wait-ms", type=int, default=400)
    ap.add_argument("--short-window-ms", type=int, default=1200)
    ap.add_argument("--cap-ms", type=int, default=650)
    ap.add_argument("--threshold", type=float, default=0.35)
    args = ap.parse_args()

    cfg = {
        "extend": args.extend_ms, "max_ext": args.max_ext, "max_unsure": args.max_unsure,
        "budget": args.budget_ms, "sequence_budget": args.sequence_budget_ms,
        "open_quiet": args.open_quiet_ms, "open_quiet_high": args.open_quiet_high_ms,
        "short_wait": args.short_wait_ms, "short_window": args.short_window_ms,
        "cap": args.cap_ms, "threshold": args.threshold,
    }

    sessions = [
        analyse_session(d, cfg, args.floor_db)
        for d in sorted(glob.glob(os.path.join(args.arch_root, "*")))
        if os.path.isdir(d) and os.path.exists(os.path.join(d, "events.jsonl"))
    ]
    all_rows = [r for s in sessions for r in s["rows"]]
    out = {"config": cfg, "summary": summarise(all_rows), "sessions": sessions}

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)

    s = out["summary"]
    print(json.dumps(s, ensure_ascii=False, indent=2))
    print()
    print(f"{'轮':<4} {'②旧':>5} {'②新':>5} {'Δ':>5} {'总旧':>6} {'总优':>6} {'暴露':<12} {'吸收':>4} {'砍掉':>4} {'旧结局':<12} {'新结局':<12} 文本")
    for ses in sessions:
        for r in ses["rows"]:
            if r["n_decides"] == 0 and r["delta_ms"] == 0:
                continue
            print(
                f"{r['turn']:<4} {str(r['gap_old_ms']):>5} {str(r['gap_new_ms']):>5} {r['delta_ms']:>5}"
                f" {str(r['total_old_ms']):>6} {str(r['total_opt_ms']):>6} {r['exposure']:<12}"
                f" {r['absorbed_speeches']:>4} {r['lost_speeches']:>4}"
                f" {str(r['outcome_old']):<12} {str(r['outcome_new']):<12} {r['text'][:20]}"
            )

    # ---- 清点：判停真正「等到」的那些话，在新策略下还在不在等待窗里 ----
    print()
    print("=== 清点：被旧等待吸收的话 vs 新策略的放行点（ms，全部相对本轮定稿）===")
    total_absorbed = total_lost = total_before = total_after = total_unknown = 0
    for ses in sessions:
        for r in ses["rows"]:
            if r["absorbed_speeches"] == 0:
                continue
            total_absorbed += r["absorbed_speeches"]
            total_lost += r["lost_speeches"]
            total_before += r["lost_before_audio"]
            total_after += r["lost_after_audio"]
            total_unknown += r["lost_unknown"]
            mark = "砍掉" if r["lost_speeches"] else ""
            print(
                f"\n[{ses['session'][:15]} #{r['turn']}] ② {r['gap_old_ms']}→{r['gap_new_ms']} ms"
                f"  暴露={r['exposure']}  「{r['text'][:22]}」"
            )
            print(f"   旧：放行 {r['gap_old_ms']} ms" + (f"、出声 {r['total_old_ms']} ms" if r['total_old_ms'] else "、无声表"))
            print(f"   新：放行 {r['new_accept_at_ms']} ms" + (
                f"、出声 {r['new_audio_at_ms']} ms" if r['new_audio_at_ms'] is not None else "、无声表"))
            for t in r["absorbed_at_ms"]:
                if r["new_accept_at_ms"] is None:
                    tag = "?"
                elif t <= r["new_accept_at_ms"]:
                    tag = "仍在等待窗内"
                elif r["new_audio_at_ms"] is not None and t <= r["new_audio_at_ms"]:
                    tag = "放行后、出声前被吸收"
                elif r["new_audio_at_ms"] is None:
                    tag = "放行后、无声表"
                else:
                    tag = "出声后 → 会被打断"
                print(f"   用户再说一句 {t} ms → {tag}")
    print(f"\n合计：被吸收 {total_absorbed} 次；新策略下 {total_absorbed - total_lost} 次仍在等待窗内，"
          f"砍掉 {total_lost} 次（出声前被吸收 {total_before}、出声后 {total_after}、无声表 {total_unknown}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
