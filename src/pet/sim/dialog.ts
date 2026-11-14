/**
 * 对话环的模拟：在虚拟时间上跑**生产那一份** {@link DialogRuntime}。
 *
 * 对应 ADR-0002 §10.7 的"补对话场景（插话、拍照问答、播报让位）"。
 *
 * <h2>它证明什么</h2>
 *
 * 对话层（用户说话 → agent → TTS → 下发 → 插话）**不插设备、不联网**就能跑完，
 * 而且"播放中被插话"这种时序不用真等音频播完。状态机、拍照收件箱、一轮的串行队列
 * 都是 `app/dialog.ts` 里的同一份代码 —— 这里只把环境（下发、落盘、结束）
 * 换成计数器和数组。
 *
 * <h2>它还不证明什么</h2>
 *
 * ASR、上行音频、TLS 不在模拟范围（ADR-0002 §1 的非目标）：本器直接喂"一句话定稿了"。
 */
import type { DeviceCall, DeviceCapabilities, DeviceEvent } from '../../devices/primitives.ts';
import type { DownlinkSink } from '../../transport.ts';
import { DialogRuntime } from '../../app/dialog.ts';
import type { AgentProvider, AgentReplyView, TtsProvider } from '../../providers.ts';
import { SessionCore } from '../../session-core.ts';
import type { ImageAttachment } from '../../session.ts';
import type { PhotoInbox } from '../../photo-inbox.ts';
import type { TurnRunner } from '../../turn-runner.ts';
import type { CoreEffect } from '../../session-core.ts';
import { VirtualClock } from './clock.ts';

/** 一次下发的音频。 */
export interface SentAudio {
  readonly at: number;
  readonly bytes: number;
}

export interface DialogSimOptions {
  readonly caps: DeviceCapabilities;
  /** agent 回复（含延迟）；默认 0 延迟回一句 */
  readonly reply?: { latencyMs?: number; text?: string };
  /** TTS 每字对应多少毫秒音频；默认 180 */
  readonly ttsMsPerChar?: number;
  /** TTS 采样率；默认 24 kHz */
  readonly ttsRate?: number;
  readonly photoTimeoutMs?: number;
  /**
   * 播报时的开麦延迟（毫秒）：`undefined` = 设备不支持开麦，`null` = 永远不开，
   * 数字 = 这么多毫秒后出首帧。默认 300。
   */
  readonly micOpenAfterMs?: number | null;
  /** 长思考回执（不给自己不加，既有场景的时间线保持不变） */
  readonly filler?: { readonly firstAfterMs: number; readonly intervalMs: number; readonly lines: readonly string[] };
}

/** 只发不播的下行：记录字节数与时刻。 */
class CountingDownlink implements DownlinkSink {
  readonly sent: SentAudio[] = [];
  readonly controls: Array<{ at: number; text: string }> = [];
  private readonly clock: VirtualClock;

  constructor(clock: VirtualClock) {
    this.clock = clock;
  }

  sendAudio(pcm: Buffer): void {
    this.sent.push({ at: this.clock.now(), bytes: pcm.length });
  }

  sendControl(text: string): void {
    this.controls.push({ at: this.clock.now(), text });
  }

  get bytes(): number {
    return this.sent.reduce((sum, chunk) => sum + chunk.bytes, 0);
  }
}

export class DialogSim {
  readonly clock: VirtualClock;
  readonly runtime: DialogRuntime;
  readonly downlink: CountingDownlink;
  /** 下发给设备的操作 */
  readonly calls: DeviceCall[] = [];
  /** agent 收到的提问 */
  readonly asked: Array<{ text: string; image: boolean; at: number; note?: string }> = [];
  /** 执行过的效果（调试用） */
  readonly effects: CoreEffect[] = [];
  /** 一轮的开始 / 结束次数（生产用它们占话筒，必须成对） */
  turnsStarted = 0;
  turnsEnded = 0;

  constructor(options: DialogSimOptions) {
    this.clock = new VirtualClock(0, 12);
    this.downlink = new CountingDownlink(this.clock);

    const agent: AgentProvider = {
      name: 'sim',
      reply: (text, image, note) => {
        this.asked.push({ text, image: image !== undefined, at: this.clock.now(), note });
        const latency = options.reply?.latencyMs ?? 0;
        const answer: AgentReplyView = {
          text: options.reply?.text ?? '嗯，看到了。',
          speech: options.reply?.text ?? '嗯，看到了。',
          emotion: 'calm',
        };
        if (latency <= 0) {
          return Promise.resolve(answer);
        }
        return new Promise<AgentReplyView>((resolve) => {
          this.clock.after(latency, () => resolve(answer));
        });
      },
    };

    const rate = options.ttsRate ?? 24_000;
    const msPerChar = options.ttsMsPerChar ?? 180;
    const tts: TtsProvider = {
      name: 'sim',
      sampleRate: rate,
      async *synthesize(text: string): AsyncIterable<Buffer> {
        // 一次给一块，长度正好等于"这句话该占的时长"
        const samples = Math.max(1, Math.round(([...text].length * msPerChar * rate) / 1000));
        yield Buffer.alloc(samples * 2);
      },
    };

    const micOpenAfterMs = options.micOpenAfterMs === undefined ? 300 : options.micOpenAfterMs;
    this.runtime = new DialogRuntime({
      clock: this.clock,
      caps: options.caps,
      agent,
      tts,
      downlink: this.downlink,
      imageQuestion: '你看到了什么？',
      photoDir: '',
      photoTimeoutMs: options.photoTimeoutMs ?? 4_000,
      confirmTimeoutMs: options.photoTimeoutMs ?? 4_000,
      playbackTailMs: 0,
      ...(options.filler === undefined ? {} : { filler: options.filler }),
      env: {
        call: (call) => {
          this.calls.push(call);
          return true;
        },
        // 模拟器直接喂定稿的句子，不经过分句攒句
        assemble: () => {},
        end: () => {},
        onEffect: (effect) => { this.effects.push(effect); },
        // 生产用这两个钩子占话筒（`AppSession.turnStart/turnEnd`），必须成对
        onTurnStart: () => { this.turnsStarted += 1; },
        onTurnEnd: () => { this.turnsEnded += 1; },
        ...(micOpenAfterMs === undefined
          ? {}
          : {
            announceMic: {
              listenStart: true,
              micOpenTimeoutMs: 1_500,
              listenMs: 8_000,
              call: (call: DeviceCall) => { this.calls.push(call); },
              awaitMicOpen: (timeoutMs: number) => this.waitMic(micOpenAfterMs, timeoutMs),
            },
          }),
      },
      log: () => {},
    });
  }

  get core(): SessionCore {
    return this.runtime.core;
  }

  get photos(): PhotoInbox {
    return this.runtime.photos;
  }

  get runner(): TurnRunner {
    return this.runtime.runner;
  }

  /** 推进虚拟时间，并让在途的一轮跑完。 */
  async until(offset: number): Promise<void> {
    await this.clock.runUntil(offset);
  }

  /** 用户说完一句。 */
  async utterance(text: string): Promise<void> {
    this.runtime.dispatch({ type: 'utterance', text });
    await this.flush();
  }

  /** 用户开口（插话）。 */
  async partial(text: string): Promise<void> {
    this.runtime.dispatch({ type: 'partial', text });
    await this.flush();
  }

  /** 设备回了一张图（没有请求在等）。 */
  async image(jpeg: Buffer): Promise<void> {
    this.runtime.dispatch({ type: 'image', jpeg });
    await this.flush();
  }

  /** 设备事件（拍照等待 / 失败）。 */
  async deviceEvent(event: DeviceEvent): Promise<void> {
    const say = this.photos.onEvent(event);
    if (say !== null) {
      await this.runner.speakCanned(say);
    }
    await this.flush();
  }

  /** 用户在等图期间按了快门：把图交给收件箱。 */
  async captureResult(id: string, jpeg: Buffer | null): Promise<void> {
    if (jpeg !== null) {
      this.photos.deliver(id, jpeg);
    }
    await this.flush();
  }

  async close(): Promise<void> {
    this.runtime.dispatch({ type: 'closed' });
    await this.flush();
  }

  dispose(): void {
    this.runtime.dispose();
  }

  /** 后台汇报（走 `DialogRuntime` 的播报队列）。 */
  announce(text: string): void {
    this.runtime.enqueueAnnounce(text);
  }

  /** 等首帧上行，最多 `timeoutMs`；`null` = 永远不开。 */
  private waitMic(openAfterMs: number | null, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (openAfterMs === null || openAfterMs > timeoutMs) {
        this.clock.after(timeoutMs, () => resolve(false));
        return;
      }
      this.clock.after(openAfterMs, () => resolve(true));
    });
  }

  /** 排空微任务（不推进时间）。 */
  async flush(): Promise<void> {
    for (let index = 0; index < 64; index += 1) {
      await Promise.resolve();
    }
  }

  /** 至今为止下发的总字节数（断言"真的出声了"用）。 */
  get audioBytes(): number {
    return this.downlink.bytes;
  }

  /** 给 agent 的图（`ImageAttachment`）—— 场景里断言用。 */
  static attachment(jpeg: Buffer): ImageAttachment {
    return { mimeType: 'image/jpeg', data: jpeg.toString('base64') };
  }
}
