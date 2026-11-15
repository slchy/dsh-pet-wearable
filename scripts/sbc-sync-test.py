"""
验证 ffmpeg 对 uplink.sbc 的解码是否依赖 syncword 值。

事实：
- 每帧 57 字节，首字节 100% 是 0xAD（HFP mSBC 的 H2 header 首字节）
- 标准 SBC 的 syncword 是 0x9C，全文件只偶然出现 1388 次
- ffmpeg 却解出 33110 帧、248.3 s，且语音可被 ASR 正确识别

实验：把每个 57 字节帧的首字节 0xAD 改写成 0x9C，重新解码。
- 若 PCM 与原解码**完全一致** -> ffmpeg 没看 syncword，帧边界靠别的机制
- 若**明显不同** -> 说明其中一种是对齐正确、另一种是碰巧能出声

   python3 sbc-sync-test.py <uplink.sbc> <输出目录>
"""
import sys
import os
import subprocess
import hashlib
import numpy as np


def decode(path):
    r = subprocess.run(
        ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'sbc', '-i', path,
         '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1'],
        capture_output=True)
    if r.returncode != 0:
        return None, r.stderr.decode('utf-8', 'replace')[:300]
    return r.stdout, None


def spectrum(pcm, label):
    a = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768.0
    sr = 16000
    w = sr // 10
    n = len(a) // w
    ch = a[:n * w].reshape(n, w)
    db = 20 * np.log10(np.maximum(np.abs(ch).max(axis=1), 1e-9))
    sel = ch[db > -35]
    if not len(sel):
        print('  %s: 无有声窗' % label)
        return
    y = sel.reshape(-1)
    y = y - y.mean()
    N = 1 << 13
    acc = np.zeros(N // 2 + 1)
    k = 0
    for i in range(0, len(y) - N, N // 2):
        acc += np.abs(np.fft.rfft(y[i:i + N] * np.hanning(N))) ** 2
        k += 1
    psd = acc / max(k, 1)
    f = np.fft.rfftfreq(N, 1 / sr)
    ref_m = (f >= 500) & (f < 1500)
    ref = 10 * np.log10(max(psd[ref_m].mean(), 1e-30))
    out = ['%s: 样本 %d (%.1f s) 有声 %d 窗' % (label, len(a), len(a) / sr, len(sel))]
    for lo, hi in [(500, 1500), (1500, 2000), (2000, 3000), (3000, 4000), (4000, 6000)]:
        m = (f >= lo) & (f < hi)
        d = 10 * np.log10(max(psd[m].mean(), 1e-30)) - ref
        out.append('    %d-%d Hz: %+.1f dB' % (lo, hi, d))
    print('\n'.join(out))


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else 'uplink.sbc'
    outdir = sys.argv[2] if len(sys.argv) > 2 else '/tmp'
    raw = bytearray(open(src, 'rb').read())
    nframe = len(raw) // 57
    print('原文件 %d 字节 / 57 = %d 帧' % (len(raw), nframe))

    leads = set(raw[i * 57] for i in range(nframe))
    print('  每帧首字节的种类: %s' % ', '.join('0x%02X' % v for v in sorted(leads)))

    # 造两个变体
    variants = {'as-is': bytes(raw)}

    patched = bytearray(raw)
    for i in range(nframe):
        patched[i * 57] = 0x9C
    variants['0x9C首字节'] = bytes(patched)

    # 第三种：把前 4 字节整体换成标准 mSBC 头（0x9C, 0x19?, ...）先不动，只测首字节
    results = {}
    for name, data in variants.items():
        p = os.path.join(outdir, 'sync-%s.sbc' % ('orig' if name == 'as-is' else 'patched'))
        open(p, 'wb').write(data)
        pcm, err = decode(p)
        if pcm is None:
            print('\n[%s] ffmpeg 解码失败: %s' % (name, err))
            results[name] = None
            continue
        h = hashlib.sha256(pcm).hexdigest()[:16]
        print('\n[%s] 解出 %d 字节 PCM  sha256=%s' % (name, len(pcm), h))
        spectrum(pcm, name)
        results[name] = pcm

    a, b = results.get('as-is'), results.get('0x9C首字节')
    if a is not None and b is not None:
        n = min(len(a), len(b))
        x = np.frombuffer(a[:n], dtype='<i2').astype(np.float32)
        y = np.frombuffer(b[:n], dtype='<i2').astype(np.float32)
        same = int((x == y).all())
        if same:
            print('\n>>> 改 syncword 后 PCM 逐样本完全一致 → ffmpeg 不看这个字节')
        else:
            diff = np.abs(x - y)
            print('\n>>> 改 syncword 后 PCM 有差异：%d/%d 样本不同，最大差 %.0f，相关系数 %.4f'
                  % (int((diff > 0).sum()), n, diff.max(), np.corrcoef(x, y)[0, 1]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
