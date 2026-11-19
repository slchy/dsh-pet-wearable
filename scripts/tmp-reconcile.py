"""临时：逐轮对账（只用「回答」那条 TTS task，回执/兜底那条带"合计"要排除）。用完即删。"""
import os
import re

OUT = os.path.join(os.path.dirname(__file__), "..", "bench", "replay", "out")
RUNS = [("A(6,2)", "trace-t1-A.log"), ("A(6,2)", "trace-t3-A.log"),
        ("B(2,3)", "trace-t2-B.log"), ("B(2,3)", "trace-t4-B.log")]
LIUSHI = "\uff08\u6d41\u5f0f"   # （流式
HEJI = "\u5408\u8ba1"            # 合计


def parse(path):
    turns, cur = [], None
    for ln in open(path, encoding="utf-8"):
        s = ln.strip()
        if s.startswith("TURN n="):
            m = dict(re.findall(r"(\w+)=([\w.\-]+)", s))
            if cur is not None:
                cur.update(turn=int(m.get("n", 0)),
                           tts_first_ms=round(float(m.get("tts_first_ms", 0))),
                           path=m.get("path"), audio_s=float(m.get("audio_s", 0)))
                turns.append(cur)
            cur = None
            continue
        if "=stream" in s and s.startswith("\u6d41\u5f0f"):   # 流式 分支=stream
            cur = {"setup": None, "first": None, "llm": None, "batches": 0}
            continue
        if cur is None:
            continue
        if s.startswith("TTS " + "\u9001\u6279"):              # TTS 送批
            cur["batches"] += 1
        elif s.startswith("TTS task") and LIUSHI in s and HEJI not in s:
            nums = [int(x) for x in re.findall(r"(\d+)\s*ms", s)]
            if len(nums) >= 2:
                cur["setup"], cur["first"] = nums[0], nums[1]
        elif "\u9996\u5b57\uff08\u6d41\u5f0f\uff09" in s:      # 首字（流式）
            m = re.search(r"(\d+) ms", s)
            if m:
                cur["llm"] = int(m.group(1))
    return turns


rows = []
for label, f in RUNS:
    for t in parse(os.path.join(OUT, f)):
        if t["first"] is None:
            continue
        rows.append({**t, "label": label, "send": t["tts_first_ms"] - t["first"]})


def pct(v, p):
    v = sorted(v)
    k = (len(v) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(v) - 1)
    return round(v[lo] + (v[hi] - v[lo]) * (k - lo))


print(f"{'配置':9}{'轮':>3}{'path':>6}{'建立':>6}{'首包':>6}{'送批延迟':>9}{'tts.first':>10}"
      f"{'模型首字':>9}  慢?")
for r in rows:
    slow = "\u2605" if r["setup"] > 150 else ""
    print(f"{r['label']:9}{r['turn']:>3}{str(r['path']):>6}{r['setup']:>6}{r['first']:>6}"
          f"{r['send']:>9}{r['tts_first_ms']:>10}{str(r['llm']):>9}  {slow}")

print()
spikes = [r for r in rows if r["setup"] > 150]
norm = [r for r in rows if r["setup"] <= 150]
for lab in ("A(6,2)", "B(2,3)"):
    sub = [r for r in rows if r["label"] == lab]
    sp = [r for r in sub if r["setup"] > 150]
    print(f"{lab}: 回答任务 {len(sub)}，建立尖峰 {len(sp)}")

print(f"\n尖峰 {len(spikes)} 轮 vs 正常 {len(norm)} 轮（中位数）")
for key in ("first", "send", "tts_first_ms", "llm"):
    a = [r[key] for r in spikes if r[key] is not None]
    b = [r[key] for r in norm if r[key] is not None]
    print(f"  {key:12} 尖峰 {pct(a, .5):>5}   正常 {pct(b, .5):>5}   差 {pct(a, .5) - pct(b, .5):+}")
