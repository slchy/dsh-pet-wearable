"""临时：把 harness.log（带 COSYVOICE_TRACE）按轮切开，逐轮对账。用完即删。

每轮的日志块长这样（顺序固定）：
  流式    分支=stream（边生成边合成）
  TTS 送批 "哥，"
  快车道    NNN ms 首字（流式） ："..."
  agent    0.NN s  "..."
  TTS task  建立 X ms  首包 Y ms （流式：首包自首批文本送出起算）
  TTS首块 0.NN s
  TURN n=k ... tts_first_ms=... path=fast

从 `tts.first.ms` 的定义（turn-runner：首个 delta → 首块音频）可以拆成
  tts_first_ms = 送批延迟 + 首包
所以「送批延迟」= tts_first_ms − 首包，这一段是**我们自己**等文本攒够一批的时间。
"""
import re
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "bench", "replay", "out")
RUNS = [("A(6,2)", "trace-t1-A.log"), ("A(6,2)", "trace-t3-A.log"),
        ("B(2,3)", "trace-t2-B.log"), ("B(2,3)", "trace-t4-B.log")]


def parse(path):
    turns = []
    cur = None
    for ln in open(path, encoding="utf-8", errors="replace"):
        s = ln.strip()
        if s.startswith("TURN n="):
            m = dict(re.findall(r"(\w+)=([\w.\-]+)", s))
            if cur is not None:
                cur["turn"] = int(m.get("n", 0))
                cur["tts_first_ms"] = round(float(m.get("tts_first_ms", 0)))
                cur["path"] = m.get("path")
                cur["dsh_ms"] = round(float(m.get("dsh_ms", 0)))
                turns.append(cur)
            cur = None
            continue
        if s.startswith("流式") and "分支=stream" in s:
            cur = {"batches": [], "setup": None, "first": None, "llm": None, "tts_log": None}
            continue
        if cur is None:
            continue
        if s.startswith("TTS 送批"):
            cur["batches"].append(s[len("TTS 送批"):].strip())
        elif s.startswith("TTS task") and "流式" in s:
            nums = [int(x) for x in re.findall(r"(\d+)\s*ms", s)]
            if len(nums) >= 2:
                cur["setup"], cur["first"] = nums[0], nums[1]
        elif "首字（流式）" in s:
            m = re.search(r"(\d+) ms 首字", s)
            if m:
                cur["llm"] = int(m.group(1))
        elif s.startswith("TTS首块"):
            cur["tts_log"] = s
    return turns


def pct(v, p):
    v = sorted(v)
    if not v:
        return None
    k = (len(v) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(v) - 1)
    return round(v[lo] + (v[hi] - v[lo]) * (k - lo))


rows = []
for label, f in RUNS:
    for t in parse(os.path.join(OUT, f)):
        if t["path"] != "fast" or t["first"] is None:
            continue
        rows.append({**t, "label": label,
                     "send_delay": t["tts_first_ms"] - t["first"]})

print(f"{'配置':9} {'轮':>3} {'建立':>5} {'首包':>5} {'送批延迟':>7} {'tts.first':>9} "
      f"{'模型首字':>7}  尖峰?")
for r in rows:
    sp = "★" if r["setup"] > 150 else ""
    print(f"{r['label']:9} {r['turn']:>3} {r['setup']:>5} {r['first']:>5} "
          f"{r['send_delay']:>7} {r['tts_first_ms']:>9} {str(r['llm']):>7}  {sp}")

print()
for label in ("A(6,2)", "B(2,3)"):
    sub = [r for r in rows if r["label"] == label]
    for key in ("setup", "first", "send_delay", "tts_first_ms", "llm"):
        v = [r[key] for r in sub if r[key] is not None]
        print(f"{label:9} {key:12} n={len(v):>2} p50 {pct(v, .5):>5} p90 {pct(v, .9):>5} "
              f"max {max(v):>5}")
    print()

spikes = [r for r in rows if r["setup"] > 150]
norm = [r for r in rows if r["setup"] <= 150]
print(f"尖峰 {len(spikes)} 轮 vs 正常 {len(norm)} 轮：")
for key in ("first", "send_delay", "tts_first_ms", "llm"):
    a = [r[key] for r in spikes if r[key] is not None]
    b = [r[key] for r in norm if r[key] is not None]
    print(f"  {key:12} 尖峰 p50 {pct(a, .5):>5} (n={len(a)})   正常 p50 {pct(b, .5):>5} (n={len(b)})")
