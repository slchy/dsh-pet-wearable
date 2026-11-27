/**
 * 对话层的**决策**：给定事件，产出「接下来做什么」。
 *
 * 这里没有 socket、没有 ffmpeg、没有定时器 —— 副作用都以 `CoreEffect` 返回，
 * 由宿主执行。抽出来的理由：最容易出错的是判断本身（旁听反馈要不要成轮、
 * 插话算不算数、识图轮从哪来），而这些用单测就能钉住，不必起连接。
 */
import { isBackchannelOnly } from './backchannel.ts';
import {
  captureMode,
  type CaptureFailure,
  type DeviceCall,
  type DeviceCapabilities,
} from './devices/primitives.ts';
import { V1_BASELINE } from './devices/wire-v1.ts';
import { DialogFsm, type DialogFsmContext, type DialogState, type TurnTicket } from './dialog-fsm.ts';
import { isPreTurnCommit } from './kernel.ts';
import type { KernelRuntime } from './kernel-runtime.ts';
import { wantsHighRes } from './hq-intent.ts';
import type { CaptureRequest } from './photo-inbox.ts';
import type { ImageAttachment } from './session.ts';
import { isWakeWordOnly } from './wake-word.ts';

/**
 * 拍照失败 → 交给模型的一句话。
 *
 * 设备给了原因（`say`）就转述；没给就只说拿不到 —— 不猜是快门、P2P 还是传输。
 */
export function captureFailureHint(failure: CaptureFailure): string {
  return failure.say === undefined
    ? `没能拿到高清图（${failure.code}）。请如实说明拿不到照片，不要凭空描述。`
    : `没能拿到高清图：${failure.say}。请把这个原因告诉用户，不要凭空描述画面。`;
}

export type CoreEvent =
  /**
   * STT 出了一句（还没合并）。
   *
   * `commitSeq` 是产出这段转写的那一发 ASR commit —— 因果屏障只认它（见
   * `kernel.ts` 的 `isPreTurnCommit`）。服务端 VAD 的 provider 不知道序号时不传。
   */
  | { readonly type: 'sentence'; readonly text: string; readonly commitSeq?: number }
  /** 一句话合并定稿（判停窗口已关） */
  | {
    readonly type: 'utterance';
    readonly text: string;
    /** 本轮未切碎的完整 16 kHz PCM16（整句精转用，跨多次 ASR commit） */
    readonly utterancePcm?: Buffer;
  }
  /** STT 的中间结果（插话判据）。`commitSeq` 同上 */
  | { readonly type: 'partial'; readonly text: string; readonly commitSeq?: number }
  /** 设备回了一张图，且没有拍照请求在等它 */
  | { readonly type: 'image'; readonly jpeg: Buffer }
  /**
   * 一次拍照有了结果（成功或失败都算）。
   *
   * 由宿主在 `DeviceCall` 收尾后派发 —— 状态机在 `awaiting_shot` 期间什么都
   * 做不了，必须靠这个事件才能回到 `thinking`。失败带 `code` + `say`：
   * 判定看 `code`，措辞看 `say`（设备给的原因）。
   */
  | {
    readonly type: 'shotResult';
    readonly ok: boolean;
    readonly jpeg?: Buffer;
    readonly failure?: CaptureFailure;
  }
  /** 一轮跑完（音频下发结束） */
  | { readonly type: 'turnFinished' }
  /** 外部（工具口 / 模型）要求收尾 */
  | { readonly type: 'endRequested' }
  | { readonly type: 'closed' };

export type CoreEffect =
  /** 交给人声合并器 */
  | { readonly type: 'assemble'; readonly text: string }
  | {
    readonly type: 'turn';
    readonly text: string;
    readonly image?: ImageAttachment;
    readonly ticket: TurnTicket;
    /** 透传给 `TurnInput.utterancePcm`（整句精转用） */
    readonly utterancePcm?: Buffer;
  }
  /**
   * 一个**设备操作**。判定核只说做什么，怎么说（v1 控制串 / v2 操作帧）
   * 由执行层决定。
   */
  | { readonly type: 'call'; readonly call: DeviceCall }
  /**
   * 要一张图：`listening → awaiting_shot`。
   *
   * 「要不要等用户动手」由 `request.needsUser` 决定，状态机只有这一条拍照流程。
   */
  | {
    readonly type: 'capture';
    readonly request: CaptureRequest;
    readonly text: string;
    readonly ticket: TurnTicket;
  }
  /** 挂断 */
  | { readonly type: 'end' }
  /** 有意丢弃（唤醒词 / 旁听反馈），只为可观测 */
  | { readonly type: 'drop'; readonly why: string };

export interface SessionCoreOptions {
  /**
   * 设备能力：决定忽略哪些短语、「看清细节」能不能自动拍。
   *
   * 缺省 {@link V1_BASELINE}。判定核只读能力，不认型号。
   */
  readonly capabilities?: DeviceCapabilities;
  /** 没人等图时的默认提问 */
  readonly imageQuestion: string;
  readonly log: (line: string) => void;
  /**
   * 票据上的 `baseCommitSeq` / `startedAtMs` 从哪来（见 `dialog-fsm.ts` 的
   * `DialogFsmContext`）。由 `VoiceSession` 注入 —— 只有它认识 ASR。
   */
  readonly ticketContext?: DialogFsmContext;
  /**
   * 共享的内核运行时。装配层（`DialogRuntime`）传入自己那一个（已按
   * `initialKernelState(0, agent.lastLedgerLane?.() ?? null)` 播种并绑好端口）；
   * 不传就由 `DialogFsm` 新建一个 —— 一个会话只该有**一份** `KernelState`。
   */
  readonly runtime?: KernelRuntime;
}

export class SessionCore {
  /** 传给 TurnRunner：一轮的生命周期仍由它驱动 */
  readonly fsm: DialogFsm;

  private readonly options: SessionCoreOptions;
  private readonly caps: DeviceCapabilities;

  /**
   * 正在等高清照的那句话。
   *
   * 放在这里而不是宿主里：它是**状态**（`awaiting_shot` 期间有效），要随
   * `abortAwaitShot` / `closed` 一起清掉，放宿主一定会漏。
   */
  private pendingShot: {
    text: string;
    ticket: TurnTicket;
    id: string;
    /** `capture → shotResult` 路径同样不许丢整句 PCM */
    readonly utterancePcm?: Buffer;
  } | null = null;

  constructor(options: SessionCoreOptions) {
    this.options = options;
    this.caps = options.capabilities ?? V1_BASELINE;
    this.fsm = new DialogFsm(options.log, options.ticketContext, options.runtime);
  }

  /** 取消正在等的拍照：解散设备侧流程，并清掉已经在播的旁白。 */
  private cancelCapture(): CoreEffect[] {
    const pending = this.pendingShot;
    if (pending === null) {
      return [];
    }
    this.pendingShot = null;
    return [
      { type: 'call', call: { op: 'capture.cancel', id: pending.id } },
      { type: 'call', call: { op: 'audio.stop' } },
    ];
  }

  /**
   * 唯一的内核运行时（相位 + 账本 + 因果裁决都在里面）。
   *
   * 一个会话只该有**一份** `KernelState`：`DialogFsm` 是它的门面（`this.fsm.runtime`），
   * `DialogRuntime` / `TurnRunner` / `VoiceConnection` 拿到的是同一个实例 ——
   * 这样「状态机说 speaking、内核说 thinking」这类双份状态在结构上不存在。
   */
  get runtime(): KernelRuntime {
    return this.fsm.runtime;
  }

  get phase(): DialogState {
    return this.fsm.state;
  }

  get turn(): number {
    return this.fsm.turn;
  }

  dispatch(event: CoreEvent): CoreEffect[] {
    switch (event.type) {
      case 'sentence': {
        // 因果屏障：**唯一**一处判定，谓词在 `kernel.ts`（`isPreTurnCommit`）。
        // 开轮前就已经录进去的那段迟到转写既不能打断，也不能开轮 —— 它只是那一轮
        // 自己的后半句（真机「自己后半句杀自己」）。
        if (isPreTurnCommit(this.runtime.state, event.commitSeq)) {
          this.options.log('  （开轮前录的那段定稿 → 不当插话，也不开轮）');
          return [{ type: 'drop', why: 'pre-turn' }];
        }
        if (isWakeWordOnly(event.text, this.caps.ignorePhrases)) {
          this.options.log('  → 唤醒词，丢弃（不算一轮）');
          return [{ type: 'drop', why: 'wake-word' }];
        }
        // **定稿也要打断**。短促的插话（「退下」「好了」）常常只出定稿、不出中间结果，
        // 只听 `partial` 就会漏掉 —— 真机上表现为「有时候打断立刻生效、有时候要等
        // 下一句才停」。`bargeIn` 只在 `speaking` 成立，所以不会误伤别的状态。
        //
        // 但**旁听反馈不算**：`partial` 那条路径靠「不足 2 字」挡住了「嗯」，
        // 一整句「嗯。」却会绕过那道过滤。真机日志里它把正在播的回复打断了
        // （`插话「嗯。」→ 代次 4`），而同一个「嗯」作为中间结果什么都没做。
        // 同一句话不该因为 ASR 有没有加句号而有两种行为。
        //
        // 停音频 / 作废轮次 / 结算都由内核在 `bargeIn` 这条事件上声明，`DialogFsm`
        // 走 `dispatchAndApply` 执行 —— 这里**不补** `audio.stop`，否则就是双份。
        if (!isBackchannelOnly(event.text)) {
          this.fsm.bargeIn(event.text, event.commitSeq);
        }
        return [{ type: 'assemble', text: event.text }];
      }

      case 'utterance': {
        /** 等快门期间用户又说话 = 改主意：先取消拍照，再按新句子重新判 */
        const effects: CoreEffect[] = [];
        if (this.fsm.state === 'awaiting_shot') {
          this.options.log('  （等快门时用户又说话 → 取消拍照，新句子重新判）');
          effects.push(...this.cancelCapture());
          this.fsm.abortAwaitShot('用户改主意');
        }
        // 旁听反馈不单独成轮。实测：「嗯嗯，我知道了我知道了。」曾触发一次完整
        // agent 调用，回了句「行，那有需要再喊我」—— 像逐客令，用户下一句就是
        // 「哎，别别别别退。」。
        if (isBackchannelOnly(event.text)) {
          this.options.log('  （旁听反馈，不单独成轮）');
          return [...effects, { type: 'drop', why: 'backchannel' }];
        }
        // 已经决定收尾（模型调了退出工具）：麦克风虽已停，但排队中的识别结果
        // 还会到。此时再开一轮会和「告别语播完就挂断」打架。
        if (this.fsm.endAfterSpeech) {
          this.options.log('  （丢弃：已在收尾，不再开新一轮）');
          return [...effects, { type: 'drop', why: 'ending' }];
        }
        // 用户**说**要看清细节时，不等模型自己选工具：直接把高清图拍好塞给它。
        // 实测 deepseek-flash 不会稳定地按工具描述选 `take_photo_hq`（同一句话
        // 三次里两次挑了低清），所以「要不要高清」由**用户的话**决定。
        //
        // 能不能自动拍由能力决定：设备没有 `detail` 意图（v1 基线）→ 照常开一轮交给 agent。
        const mode = captureMode(this.caps, 'detail');
        if (mode !== null && wantsHighRes(event.text)) {
          const shotTicket = this.fsm.beginAwaitShot();
          if (shotTicket !== null) {
            const request: CaptureRequest = {
              id: `capture-${shotTicket.no}-${shotTicket.gen}`,
              intent: 'detail',
              needsUser: mode.needsUser,
            };
            this.pendingShot = {
              text: event.text,
              ticket: shotTicket,
              id: request.id,
              ...(event.utterancePcm === undefined ? {} : { utterancePcm: event.utterancePcm }),
            };
            this.options.log(
              `  拍照    用户要求看清细节 → ${mode.needsUser ? '等用户在设备上动手' : '直接拍'}`,
            );
            return [...effects, { type: 'capture', request, text: event.text, ticket: shotTicket }];
          }
        }
        return [...effects, {
          type: 'turn',
          text: event.text,
          ticket: this.fsm.ticket(),
          ...(event.utterancePcm === undefined ? {} : { utterancePcm: event.utterancePcm }),
        }];
      }

      case 'shotResult': {
        const pending = this.pendingShot;
        this.pendingShot = null;
        if (pending === null) {
          this.options.log('  （拍照结果已经不需要了，丢弃）');
          return [{ type: 'drop', why: 'shot-stale' }];
        }
        if (event.ok && event.jpeg !== undefined) {
          return [{
            type: 'turn',
            text: `${pending.text}\n（已附一张高清晰度照片，直接根据它回答，不要再调用拍照工具。）`,
            image: { mimeType: 'image/jpeg', data: event.jpeg.toString('base64') },
            ticket: this.fsm.ticket(),
            ...(pending.utterancePcm === undefined ? {} : { utterancePcm: pending.utterancePcm }),
          }];
        }
        const failure: CaptureFailure = event.failure ?? { code: 'failed' };
        if (failure.code === 'cancelled') {
          // 用户自己取消的：不要凭空生成一轮回答
          return [{ type: 'drop', why: 'shot-cancelled' }];
        }
        this.options.log(`  拍照    ✗ 没拿到高清图（${failure.code}），本轮按文本继续`);
        return [{
          type: 'turn',
          text: `${pending.text}\n（${captureFailureHint(failure)}）`,
          ticket: this.fsm.ticket(),
          ...(pending.utterancePcm === undefined ? {} : { utterancePcm: pending.utterancePcm }),
        }];
      }

      case 'partial': {
        // 因果屏障与定稿共用同一个谓词：开轮前录的那段迟到转写不算插话，也不开轮。
        if (isPreTurnCommit(this.runtime.state, event.commitSeq)) {
          return [{ type: 'drop', why: 'pre-turn' }];
        }
        // 插话判据用「服务端真的解出了字」，不用能量峰值 ——
        // 噪声能骗过峰值，骗不过识别器。能不能打断由状态机定（只有 speaking 算）。
        const bare = event.text.replace(/[\s。.,，!！?？、~～]/g, '');
        if (bare.length < 2) {
          return [];
        }
        // 副作用全部由内核在 `bargeIn` 上声明（`stopDeviceAudio` / `invalidateTurn` /
        // `abortEngine` / `settleTurn`），`DialogFsm` 走 `dispatchAndApply` 执行。
        this.fsm.bargeIn(event.text, event.commitSeq);
        return [];
      }

      case 'image':
        // 等高清图的时候收到 SPP 低清回图（用户按快门时相机顺带回的）：那不是我们要的
        // 那张，别用它另起一轮 —— 否则「等快门」和「识图轮」会同时活着。
        if (this.fsm.state === 'awaiting_shot') {
          this.options.log('  （等高清图期间收到低清回图，丢弃）');
          return [{ type: 'drop', why: 'spp-during-shot' }];
        }
        return [{
          type: 'turn',
          text: this.options.imageQuestion,
          image: { mimeType: 'image/jpeg', data: event.jpeg.toString('base64') },
          ticket: this.fsm.ticket(),
        }];

      case 'turnFinished':
        if (this.fsm.state === 'ending') {
          this.options.log('\n--- 会话结束（模型判定）---');
          return [{ type: 'end' }];
        }
        return [];

      case 'endRequested': {
        // 收尾时如果还在等快门，得把这个请求一起取消 —— 不然手机侧 P2P 会挂到
        // 自己的 20 s 超时才散，用户已经听过告别语了灯还亮着。
        const cancelling = this.fsm.state === 'awaiting_shot';
        const effects: CoreEffect[] = [];
        if (cancelling) {
          this.options.log('  拍照    收尾 → 取消还没到手的高清照');
          effects.push(...this.cancelCapture());
        }
        this.fsm.requestEnd();
        // 模型决定收尾的那一刻，眼镜就该停止采集 —— 不能等告别语播完。
        // `endVoiceSession()`（Aivs 六字段全 0）实测能让设备立刻停流（§19.5）。
        this.options.log('  采集    模型要求结束 → 通知设备停止采集');
        effects.push({ type: 'call', call: { op: 'listen.stop' } });
        if (this.fsm.state === 'ending') {
          effects.push({ type: 'end' });
        }
        return effects;
      }

      case 'closed':
        this.pendingShot = null;
        this.fsm.close();
        return [];
    }
  }
}
