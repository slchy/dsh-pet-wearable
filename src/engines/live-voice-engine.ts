/**
 * Live 引擎：omni 一体模型**直出音频**。
 *
 * 它把 {@link FastVoiceEngine} 架在既有的 {@link FastLaneAudioLane}（生产上是
 * `OmniShadow`）上面，只做三件事：转发上行帧、把认领到的音频包装成
 * {@link EngineEvent}、按内核的话放弃在途投机。
 *
 * 为什么还要这一层：内核只认 `respond()` 一条出口，**不许知道**自己是 omni 还是
 * 级联（`engine-contract.ts` 第 5 条契约）。`claim()` 的形状留在这里，内核那边
 * 就只剩「订阅、等事件、放弃投机」。
 *
 * 一条时序上的要害：`claim()` 拿到的是**活流**（首块通常还没到），而 `discard()`
 * 或者插话会让它永远不再产出 —— 所以等下一块时必须和中止信号赛跑，不能傻等
 * （`OmniShadow` 的读端会挂在 `waitLive()` 上，最长 5 s）。
 */
import type { AudioFrame, EngineEvent, FastVoiceEngine, TurnInput } from '../engine-contract.ts';
import type { FastLaneAudioLane, InjectKind } from '../providers.ts';

/**
 * Live 需要的车道：`providers.ts` 那条 + 上行音频入口。
 *
 * `feed` 是可选的：`OmniShadow` 天然满足；测试里的假车道可以只实现 `claim()`，
 * 内核照样能把一轮跑完（只是没有音频可识别）。
 */
export interface LiveAudioLane extends FastLaneAudioLane {
  feed?(pcm: Buffer, voiced?: boolean): void;
}

/**
 * `AbortSignal` 的一次性等待器。
 *
 * 不每块都挂监听：一轮有几十上百块音频，挂/摘监听会把开销堆在关键路径上。
 * 已中止时立刻兑现，调用方不用先查 `signal.aborted`。
 */
interface AbortGate {
  readonly when: Promise<null>;
  cancel(): void;
}

function abortGate(signal: AbortSignal): AbortGate {
  let fire: (() => void) | null = null;
  const when = new Promise<null>((resolve) => {
    fire = () => {
      resolve(null);
    };
    if (signal.aborted) {
      fire();
      return;
    }
    signal.addEventListener('abort', fire, { once: true });
  });
  return {
    when,
    cancel: () => {
      if (fire !== null) {
        signal.removeEventListener('abort', fire);
      }
    },
  };
}

export class LiveVoiceEngine implements FastVoiceEngine {
  readonly mode = 'live' as const;

  private readonly lane: LiveAudioLane;

  constructor(lane: LiveAudioLane) {
    this.lane = lane;
  }

  isHealthy(): boolean {
    return this.lane.willServe();
  }

  onAudioFrame(frame: AudioFrame): void {
    this.lane.feed?.(frame.pcm, frame.voiced);
  }

  async *respond(turn: TurnInput, signal: AbortSignal): AsyncGenerator<EngineEvent> {
    // 这一轮的文字没有用武之地：omni 从**封段**那一刻就开始答了
    void turn;
    if (signal.aborted) {
      return;
    }
    const answer = this.lane.claim();
    if (answer === null) {
      // 拿不到就按「零音频」结束：内核据此记账，不会假装说过话
      yield { type: 'done', fullText: '' };
      return;
    }
    // 认领成功才报路径：内核不用再看引擎类型，就知道这轮是 omni 直出
    yield { type: 'meta', path: 'omni' };

    const gate = abortGate(signal);
    let said = 0;
    const chunks = answer.chunks[Symbol.asyncIterator]();
    try {
      for (;;) {
        const step = chunks.next();
        const winner = await Promise.race([step, gate.when]);
        if (winner === null) {
          // 中止：不再等下一块，也不再产事件 —— 这一轮的声音到此为止。
          // 放弃 `step` 时要接住它后续的拒绝，否则会变成未处理的 rejection；
          // `return()` 不 await：读端可能正挂在 `waitLive()` 上。
          void Promise.resolve(step).catch(() => {});
          void Promise.resolve(chunks.return?.()).catch(() => {});
          return;
        }
        if (winner.done === true) {
          break;
        }
        yield { type: 'audio', pcm: winner.value, sampleRate: answer.sampleRate };
        // 转写是**活的**：随音频流增长。增长了多少就补多少文本增量。
        const text = answer.transcript();
        if (text.length > said) {
          const delta = text.slice(said);
          said = text.length;
          yield { type: 'text', delta };
        }
      }
    } finally {
      gate.cancel();
    }

    if (signal.aborted) {
      return;
    }
    // omni 自己决定转 dsh（`tool_call`）：音频可能已经说过一句垫话，照常播完了
    const reason = answer.delegateReason?.() ?? null;
    if (reason !== null) {
      yield { type: 'delegate', reason, rewrittenQuery: answer.delegateText?.() ?? null };
    }
    const finalText = answer.transcript();
    yield { type: 'done', fullText: finalText, speech: finalText };
  }

  abortSpeculation(reason: 'delegated' | 'superseded' | 'barge_in'): void {
    // 插话与「这一轮不要了」是两件事：前者用户已经听到一部分，回复要留着
    // （`interrupt`）；后者一个字都没播，整条回复要从服务端历史里删掉（`discard`）。
    if (reason === 'barge_in' && this.lane.interrupt !== undefined) {
      this.lane.interrupt();
      return;
    }
    this.lane.discard();
  }

  /**
   * 把别的车道答出来的内容回注进 omni 的上下文。
   *
   * 契约里没有它（它是 `FastLaneAudioLane` 的可选能力），但内核接线时要用；
   * 定义在这里 = 以后换引擎不用再判断「这个引擎支不支持回注」。
   */
  injectAnswer(userText: string, said: string, kind?: InjectKind): void {
    this.lane.injectAnswer?.(userText, said, kind);
  }
}
