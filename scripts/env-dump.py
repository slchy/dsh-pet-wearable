"""
逐窗导出上行音频的能量包络，用来确认两件事：
  1. 非语音段是不是数字静音（软件/VAD 硬切，还是麦克风本身就这样）
  2. 语音段内部有没有被切成碎片（碎片化会直接毁掉 ASR 的音素边界）

   python3 env-dump.py <uplink.pcm> [起点秒] [终点秒] [窗毫秒]
"""
import sys
import numpy as np


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'uplink.pcm'
    t0 = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
    t1 = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
    win_ms = float(sys.argv[4]) if len(sys.argv) > 4 else 100.0

    a = np.frombuffer(open(path, 'rb').read(), dtype='<i2')
    sr = 16000
    total = len(a) / sr
    if t1 <= t0:
        t1 = total
    s, e = int(t0 * sr), min(int(t1 * sr), len(a))
    seg = a[s:e].astype(np.float32) / 32768.0
    n = len(seg)
    w = int(sr * win_ms / 1000)
    m = n // w
    ch = seg[:m * w].reshape(m, w)

    peak = np.abs(ch).max(axis=1)
    rms = np.sqrt((ch ** 2).mean(axis=1))
    pdb = 20 * np.log10(np.maximum(peak, 1e-9))
    rdb = 20 * np.log10(np.maximum(rms, 1e-9))

    # 全文件统计
    allint = np.frombuffer(open(path, 'rb').read(), dtype='<i2')
    exact_zero = int((allint == 0).sum())
    tiny = int((np.abs(allint.astype(np.int32)) <= 2).sum())
    print('全文件 %d 样本 / %.1fs，恰好为 0 的占 %.2f%%，|x|<=2 LSB 的占 %.2f%%'
          % (len(allint), total, exact_zero * 100.0 / len(allint), tiny * 100.0 / len(allint)))

    # 连续静音段
    silent = np.abs(allint.astype(np.int32)) <= 2
    runs = []
    i = 0
    L = len(silent)
    while i < L:
        if silent[i]:
            j = i
            while j < L and silent[j]:
                j += 1
            runs.append((i, j - i))
            i = j
        else:
            i += 1
    runs.sort(key=lambda r: -r[1])
    print('连续静音段（|x|<=2）共 %d 段，最长 5 段：' % len(runs))
    for off, ln in runs[:5]:
        print('    %.2fs 起，长 %.2fs' % (off / sr, ln / sr))
    tot_sil = sum(r[1] for r in runs) / sr
    print('  静音总时长 %.1fs / %.1fs = %.1f%%' % (tot_sil, total, tot_sil * 100 / total))

    print('\n包络 %.0fs-%.0fs，窗宽 %.0f ms（P=峰值 dBFS，R=RMS dBFS）'
          % (t0, t1, win_ms))
    line = []
    for i in range(m):
        t = t0 + i * win_ms / 1000
        line.append('%7.2fs P%6.1f R%6.1f' % (t, pdb[i], rdb[i]))
        if len(line) == 4:
            print('  ' + ' | '.join(line))
            line = []
    if line:
        print('  ' + ' | '.join(line))

    print('\n峰值分布（每档 dBFS 的窗数占比）：')
    bins = [(-100, -80), (-80, -60), (-60, -50), (-50, -45), (-45, -40),
            (-40, -35), (-35, -30), (-30, -25), (-25, -20), (-20, 0)]
    for lo, hi in bins:
        cnt = int(((pdb >= lo) & (pdb < hi)).sum())
        print('  [%4d,%4d) %5.1f%%  %s' % (lo, hi, cnt * 100.0 / m, '#' * int(cnt * 60 / m)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
