"""
用下行 TTS 音频做参照，判断上行 mSBC 到底损失了多少高频。

上一轮用「能量占比」判断是错的：人声能量本来就在低频，占比永远是低频大。
正确做法是拿一段**已知音质良好**的音频当基准，比频谱斜率。

下行 `downlink.pcm` 是 MiMo 合成的 24 kHz 音频（音质好），
上行 `uplink.pcm` 是眼镜 mSBC 解码后的 16 kHz。

把两者都折算到**同样的频率刻度**上比较：
- 上行是话筒录的远场语音（有房间衰减）
- 下行是合成的近场语音（无房间）
所以不能直接比绝对值，只看**高频相对自己低频的衰减斜率**。

   python3 hf-compare.py <会话目录>
"""
import sys
import os
import numpy as np


def load_pcm(path):
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return None
    return np.frombuffer(open(path, 'rb').read(), dtype='<i2').astype(np.float32) / 32768.0


def speech_psd(a, sr, label):
    """取有声段的平均功率谱。返回 (freqs, psd_db_normalized)。"""
    w = sr // 10
    n = len(a) // w
    if n < 4:
        print('  %s: 太短' % label)
        return None, None
    ch = a[:n * w].reshape(n, w)
    db = 20 * np.log10(np.maximum(np.abs(ch).max(axis=1), 1e-9))
    sel = ch[db > -40]
    if not len(sel):
        print('  %s: 没有有声窗' % label)
        return None, None
    y = sel.reshape(-1)
    y = y - y.mean()

    N = 1 << 14
    acc = np.zeros(N // 2 + 1)
    k = 0
    for i in range(0, len(y) - N, N // 2):
        acc += np.abs(np.fft.rfft(y[i:i + N] * np.hanning(N))) ** 2
        k += 1
    if k == 0:
        return None, None
    psd = acc / k
    freqs = np.fft.rfftfreq(N, 1 / sr)
    psd_db = 10 * np.log10(np.maximum(psd, 1e-30))
    ref_mask = (freqs >= 500) & (freqs < 1500)
    if not ref_mask.any():
        return None, None
    psd_db = psd_db - psd_db[ref_mask].mean()
    print('  %s: 有声窗 %d, %d 段平均 (sr=%d, 分辨率 %.1f Hz)'
          % (label, len(sel), k, sr, sr / N))
    return freqs, psd_db


def band_mean(freqs, psd_db, lo, hi):
    m = (freqs >= lo) & (freqs < hi)
    return float(psd_db[m].mean()) if m.any() else float('nan')


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else '.'
    up = load_pcm(os.path.join(d, 'uplink.pcm'))
    down = load_pcm(os.path.join(d, 'downlink.pcm'))

    print('=== %s ===' % os.path.basename(os.path.normpath(d)))
    print()

    print('--- 上行（眼镜 mSBC，16 kHz）---')
    fu, pu = speech_psd(up, 16000, 'uplink') if up is not None else (None, None)
    print()
    print('--- 下行（MiMo TTS，24 kHz）---')
    fd, pd = speech_psd(down, 24000, 'downlink') if down is not None and len(down) else (None, None)

    if fu is None:
        print('\n上行没有可用数据')
        return 1

    print()
    print('=== 高频相对自己低频的衰减（归一化到 500-1500 Hz = 0 dB）===')
    print('  %-14s%12s%12s%10s' % ('频段', '上行 mSBC', '下行 TTS', '差'))
    for lo, hi in [(1500, 2000), (2000, 2500), (2500, 3000), (3000, 3500),
                   (3500, 4000), (4000, 5000), (5000, 6000), (6000, 7000), (7000, 8000)]:
        u = band_mean(fu, pu, lo, hi)
        dd = band_mean(fd, pd, lo, hi) if fd is not None else float('nan')
        diff = u - dd if not (np.isnan(u) or np.isnan(dd)) else float('nan')
        marker = ''
        if not np.isnan(diff):
            if diff < -10:
                marker = '  <- 上行明显更差'
            elif diff > 3:
                marker = '  <- 上行反而更好'
        print('  %-14s%11.1f%12.1f%10.1f%s' % ('%d-%d Hz' % (lo, hi), u, dd, diff, marker))

    print()
    print('=== 逐倍频程衰减（每升高一个倍频程掉了多少 dB）===')
    print('  参考：正常语音约 6-12 dB/oct，>15 dB/oct 说明被低通砍了')
    for label, f, p in (('上行 mSBC', fu, pu), ('下行 TTS ', fd, pd)):
        if f is None:
            continue
        octaves = []
        for base in (500, 1000, 2000):
            a = band_mean(f, p, base, base * 1.5)
            b = band_mean(f, p, base * 2, base * 3)
            if not (np.isnan(a) or np.isnan(b)):
                octaves.append('%d->%dHz: %+.1f dB' % (base, base * 2, b - a))
        print('  %s: %s' % (label, '   '.join(octaves)))

    return 0


if __name__ == '__main__':
    sys.exit(main())
