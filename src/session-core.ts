/**
 * 对话层的**决策**：给定事件，产出「接下来做什么」。
 *
 * 这里没有 socket、没有 ffmpeg、没有定时器 —— 副作用都以 `CoreEffect` 返回，
 * 由宿主执行。抽出来的理由：最容易出错的是判断本身（旁听反馈要不要成轮、
 * 插话算不算数、识图轮从哪来），而这些用单测就能钉住，不必起连接。
 */
import { isBackchannelOnly } from './backchannel.ts';
import { DialogFsm, type DialogState, type TurnTicket } from './dialog-fsm.ts';
import type { ImageAttachment } from './session.ts';
import { isWakeWordOnly } from './wake-word.ts';

export type CoreEvent =
  /** STT 出了一句（还没合并） */
  | { readonly type: 'sentence'; readonly text: string }
  /** 一句话合并定稿（判停窗口已关） */
  | { readonly type: 'utterance'; readonly text: string }
  /** STT 的中间结果（插话判据） */
  | { readonly type: 'partial'; readonly text: string }
  /** 设备回了一张图，且没有拍照请求在等它 */
  | { readonly type: 'image'; readonly jpeg: Buffer }
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
  /** 下发 `Control: stop`，停止播放 */
  | { readonly type: 'stop' }
  /** 下发 `Control: stop_capture`，让眼镜立刻停止采集（模型调了退出工具） */
  | { readonly type: 'stop_capture' }
  /** 挂断 */
  | { readonly type: 'end' }
  /** 有意丢弃（唤醒词 / 旁听反馈），只为可观测 */
  | { readonly type: 'drop'; readonly why: string };

export interface SessionCoreOptions {
  /** 没人等图时的默认提问 */
  readonly imageQuestion: string;
  readonly log: (line: string) => void;
}

export class SessionCore {
  /** 传给 TurnRunner：一轮的生命周期仍由它驱动 */
  readonly fsm: DialogFsm;

  private readonly options: SessionCoreOptions;

  constructor(options: SessionCoreOptions) {
    this.options = options;
    this.fsm = new DialogFsm(options.log);
  }

  get phase(): DialogState {
    return this.fsm.state;
  }

  get turn(): number {
    return this.fsm.turn;
  }

  dispatch(event: CoreEvent): CoreEffect[] {
    switch (event.type) {
      case 'sentence':
        if (isWakeWordOnly(event.text)) {
          this.options.log('  → 唤醒词，丢弃（不算一轮）');
          return [{ type: 'drop', why: 'wake-word' }];
        }
        return [{ type: 'assemble', text: event.text }];

      case 'utterance':
        // 旁听反馈不单独成轮。实测：「嗯嗯，我知道了我知道了。」曾触发一次完整
        // agent 调用，回了句「行，那有需要再喊我」—— 像逐客令，用户下一句就是
        // 「哎，别别别别退。」。
        if (isBackchannelOnly(event.text)) {
          this.options.log('  （旁听反馈，不单独成轮）');
          return [{ type: 'drop', why: 'backchannel' }];
        }
        // 已经决定收尾（模型调了退出工具）：麦克风虽已停，但排队中的识别结果
        // 还会到。此时再开一轮会和「告别语播完就挂断」打架。
        if (this.fsm.endAfterSpeech) {
          this.options.log('  （丢弃：已在收尾，不再开新一轮）');
          return [{ type: 'drop', why: 'ending' }];
        }
        return [{ type: 'turn', text: event.text, ticket: this.fsm.ticket() }];

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
        return [{ type: 'stop' }];
      }

      case 'image':
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

      case 'endRequested':
        this.fsm.requestEnd();
        // 模型决定收尾的那一刻，眼镜就该停止采集 —— 不能等告别语播完。
        // `endVoiceSession()`（Aivs 六字段全 0）实测能让设备立刻停流（§19.5）。
        this.options.log('  采集    模型要求结束 → 通知设备停止采集');
        return this.fsm.state === 'ending'
          ? [{ type: 'stop_capture' }, { type: 'end' }]
          : [{ type: 'stop_capture' }];

      case 'closed':
        this.fsm.close();
        return [];
    }
  }
}
