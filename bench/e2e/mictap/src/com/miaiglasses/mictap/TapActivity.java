package com.miaiglasses.mictap;

import android.app.Activity;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Bundle;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;

/**
 * 录一段 PCM16 到自己的私有目录，打完一行 MIC 日志就退出。
 *
 * <p>参数（`am start -n com.miaiglasses.mictap/.TapActivity ...`）：
 * <ul>
 *   <li>{@code --ei ms 4000} 录多久</li>
 *   <li>{@code --ei rate 16000} 采样率</li>
 *   <li>{@code --ei source 1} AudioSource（1=MIC、6=VOICE_RECOGNITION、9=UNPROCESSED）</li>
 *   <li>{@code --ei channels 1} 声道数</li>
 *   <li>{@code --ei delay 0} 开始录之前先等多久（给「先开始播、再开口」用）</li>
 * </ul>
 *
 * <p><b>为什么是 Activity 而不是 Service</b>：Android 11+ 把 RECORD_AUDIO 当
 * 「使用期间」权限，后台进程直接录不到声。Activity 一起就在前台，省掉
 * 前台服务那一整套（通知渠道、foregroundServiceType、从后台启动 FGS 的限制）。
 */
public final class TapActivity extends Activity {

    private static final String TAG = "MicTap";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        final int durationMs = Math.max(200, getInt("ms", 4000));
        final int rate = getInt("rate", 16000);
        final int source = getInt("source", MediaRecorder.AudioSource.MIC);
        final int channels = Math.max(1, Math.min(2, getInt("channels", 1)));
        final int delayMs = Math.max(0, getInt("delay", 0));
        final File out = new File(getFilesDir(), "mic.pcm");

        Thread worker = new Thread(() -> {
            int code = 1;
            try {
                code = record(out, durationMs, rate, source, channels, delayMs) ? 0 : 1;
            } catch (Throwable t) {
                Log.e(TAG, "FATAL " + t.getClass().getSimpleName() + ": " + t.getMessage());
            }
            Log.i(TAG, (code == 0 ? "DONE " : "FAILED ") + "path=" + out.getAbsolutePath());
            runOnUiThread(this::finish);
        }, "mictap");
        worker.start();
    }

    private int getInt(String key, int fallback) {
        try {
            return getIntent().getIntExtra(key, fallback);
        } catch (Throwable t) {
            return fallback;
        }
    }

    private static boolean record(
            File out, int durationMs, int rate, int source, int channels, int delayMs) throws Exception {
        if (delayMs > 0) {
            Thread.sleep(delayMs);
        }
        int channelMask = channels == 2 ? AudioFormat.CHANNEL_IN_STEREO : AudioFormat.CHANNEL_IN_MONO;
        int min = AudioRecord.getMinBufferSize(rate, channelMask, AudioFormat.ENCODING_PCM_16BIT);
        if (min <= 0) {
            Log.e(TAG, "✗ getMinBufferSize=" + min + "（采样率 " + rate + " 不支持？）");
            return false;
        }
        int bufSize = Math.max(min * 4, rate / 2);
        AudioRecord rec = new AudioRecord(source, rate, channelMask, AudioFormat.ENCODING_PCM_16BIT, bufSize);
        if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
            Log.e(TAG, "✗ AudioRecord 初始化失败 state=" + rec.getState()
                    + "（RECORD_AUDIO 没给？ pm grant com.miaiglasses.mictap android.permission.RECORD_AUDIO）");
            return false;
        }

        long want = (long) rate * 2L * channels * durationMs / 1000L;
        long written = 0;
        long peak = 0;
        double sumSq = 0;
        long samples = 0;

        FileOutputStream fos = new FileOutputStream(out);
        try {
            rec.startRecording();
            byte[] buf = new byte[bufSize];
            long deadline = System.currentTimeMillis() + durationMs + 1000L;
            while (written < want && System.currentTimeMillis() < deadline) {
                int n = rec.read(buf, 0, (int) Math.min(buf.length, want - written));
                if (n <= 0) {
                    Log.e(TAG, "✗ read=" + n + "（已写 " + written + "）");
                    break;
                }
                fos.write(buf, 0, n);
                written += n;
                for (int i = 0; i + 1 < n; i += 2) {
                    short s = (short) ((buf[i] & 0xFF) | (buf[i + 1] << 8));
                    int v = Math.abs(s);
                    if (v > peak) {
                        peak = v;
                    }
                    sumSq += (double) s * s;
                    samples += 1;
                }
            }
        } finally {
            try {
                rec.stop();
            } catch (Throwable ignored) {
                // 没起来过就没什么可停的
            }
            rec.release();
            fos.close();
        }

        double rms = samples == 0 ? 0 : Math.sqrt(sumSq / samples);
        Log.i(TAG, "MIC file=" + out.getName()
                + " bytes=" + written
                + " ms=" + (written * 1000L / ((long) rate * 2L * channels))
                + " rate=" + rate
                + " ch=" + channels
                + " source=" + source
                + " peak=" + peak
                + " rms=" + Math.round(rms));
        if (written < want / 2) {
            Log.e(TAG, "✗ 只录到 " + written + " / " + want + " 字节");
            return false;
        }
        if (peak < 50) {
            Log.e(TAG, "✗ 整段几乎全零（peak=" + peak + "）—— 静音开关 / 麦克风被占用 / 后台限制");
            return false;
        }
        return true;
    }
}
