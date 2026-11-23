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
  /** STT 出了一句（还没合并） */
  | { readonly type: 'sentence'; readonly text: string }
  /** 一句话合并定稿（判停窗口已关） */
  | { readonly type: 'utterance'; readonly text: string }
  /** STT 的中间结果（插话判据） */
  | { readonly type: 'partial'; readonly text: string }
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
  private pendingShot: { text: string; ticket: TurnTicket; id: string } | null = null;

  constructor(options: SessionCoreOptions) {
    this.options = options;
    this.caps = options.capabilities ?? V1_BASELINE;
    this.fsm = new DialogFsm(options.log, options.ticketContext);
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

  get phase(): DialogState {
    return this.fsm.state;
  }

  get turn(): number {
    return this.fsm.turn;
  }

  dispatch(event: CoreEvent): CoreEffect[] {
    switch (event.type) {
      case 'sentence': {
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
        const effects: CoreEffect[] = [];
        if (!isBackchannelOnly(event.text) && this.fsm.bargeIn(event.text)) {
          effects.push({ type: 'call', call: { op: 'audio.stop' } });
        }
        effects.push({ type: 'assemble', text: event.text });
        return effects;
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
            this.pendingShot = { text: event.text, ticket: shotTicket, id: request.id };
            this.options.log(
              `  拍照    用户要求看清细节 → ${mode.needsUser ? '等用户在设备上动手' : '直接拍'}`,
            );
            return [...effects, { type: 'capture', request, text: event.text, ticket: shotTicket }];
          }
        }
        return [...effects, { type: 'turn', text: event.text, ticket: this.fsm.ticket() }];
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
        }];
      }

      case 'partial': {
        // 插话判据用「服务端真的解出了字」，不用能量峰值 ——
        // 噪声能骗过峰值，骗不过识别器。能不能打断由状态机定（只有 speaking 算）。
        const bare = event.text.replace(/[\s。.,，!！?？、~～]/g, '');
        if (bare.length < 2) {
          return [];
        }
        if (!this.fsm.bargeIn(event.text)) {
          return [];
        }
        return [{ type: 'call', call: { op: 'audio.stop' } }];
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
