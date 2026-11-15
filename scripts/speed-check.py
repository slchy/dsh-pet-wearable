"""
把每句 ASR 结果和它的实际有效语音时长对齐，算「字/秒」。

中文正常语速 3-5 字/秒，上限约 7。若某句算出 8 字/秒以上，
说明音频里能被识别的部分远少于这句话本身——要么被 AEC/双讲吃掉，
要么 ASR 靠语言模型猜（幻觉）。这是判断「音频问题 vs 模型问题」的
最硬的定量指标。

   python3 speed-check.py <uplink.pcm> <sentences.json>

sentences.json 形如 [{"sec": 194.4, "text": "..."}, ...]，sec 为 ASR 定稿
时刻在 pcm 里的位置（events.jsonl 的 at.pcm / 32000）。
"""
import json
import sys
import numpy as np

SR = 16000
WIN = SR // 50          # 20 ms
VOICE_DB = -45.0        # 20 ms 窗峰值高于此值算「有语音」


def voiced_runs(a, s, e):
    """返回 [s,e) 区间内的高于阈值的窗数（20ms 为单位）"""
    seg = a[s:e]
    m = len(seg) // WIN
    if m <= 0:
        return 0, 0.0
    ch = seg[:m * WIN].reshape(m, WIN)
    peak = np.abs(ch).max(axis=1).astype(np.float32) / 32768.0
    db = 20 * np.log10(np.maximum(peak, 1e-9))
    on = db > VOICE_DB
    return int(on.sum()), m * WIN / SR


def main():
    pcm_path = sys.argv[1]
    js = json.load(open(sys.argv[2], encoding='utf-8'))
    a = np.frombuffer(open(pcm_path, 'rb').read(), dtype='<i2')

    print('%-6s %-42s %5s %7s %8s %8s %7s'
          % ('定稿s', '识别文本', '字数', '有声s', '区间s', '语速字/s', '判定'))
    print('-' * 96)
    rows = []
    for item in js:
        sec = float(item['sec'])
        text = item['text']
        end = int(sec * SR)
        # 往前最多找 8 秒，往后 0.5 秒（ASR 定稿总在语音之后）
        start = max(0, end - int(8.0 * SR))
        stop = min(len(a), end + int(0.5 * SR))
        n_on, span = voiced_runs(a, start, stop)
        voiced_s = n_on * WIN / SR
        chars = len([c for c in text if '\u4e00' <= c <= '\u9fff'
                     or c.isdigit() or c.isascii() and c.isalnum()])
        rate = chars / voiced_s if voiced_s > 0 else 0.0
        # 反推：按 4.5 字/秒算，这句话本应占用多少秒语音
        expect = chars / 4.5
        cover = voiced_s / expect if expect > 0 else 0.0
        flag = '正常' if rate <= 7.0 else ('? 偏快' if rate <= 9.0 else '✗ 语音不足')
        rows.append((sec, text, chars, voiced_s, span, rate, cover, flag))
        print('%-6.1f %-42s %5d %7.2f %8.2f %8.2f %7s'
              % (sec, text[:40], chars, voiced_s, span, rate, flag))

    print('\n=== 按「语音充足度」排序（cover < 0.7 说明音频里缺了太多）===')
    for r in sorted(rows, key=lambda x: x[6]):
        if r[6] < 0.8:
            print('  %6.1fs cover=%.2f  语速%.1f字/s  %s' % (r[0], r[6], r[5], r[1][:38]))
    good = [r for r in rows if r[6] >= 0.8]
    bad = [r for r in rows if r[6] < 0.8]
    print('\n语音充足 %d 句，语音不足 %d 句' % (len(good), len(bad)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
