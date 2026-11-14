/**
 * 时机给出「该开口了」之后，**怎么**开口：要不要先看一眼、说完要不要开麦。
 *
 * 纯函数，只读能力：
 * - 「看你所看」：设备能**不用人动手**拍 `glance` 才先拍一张再开口
 *   （{@link canCaptureUnprompted}）—— 要人按快门的档不能用于主动拍照，
 *   否则宠物主动找你说话还得先让你按快门
 * - 说完开麦：设备支持 `listen.start` 才开，否则用户得自己唤醒
 */
import { canCaptureUnprompted, type CaptureIntent, type DeviceCapabilities } from '../devices/primitives.ts';
import type { PetMove } from './pet-timing.ts';

export interface ProactivePlan {
  readonly kind: 'greet' | 'chatter';
  /** 先拍哪一档；`null` = 不拍 */
  readonly look: CaptureIntent | null;
  /** 说完之后开麦听多久；`null` = 不开 */
  readonly listenMs: number | null;
}

export interface ProactiveOptions {
  /** 主动开口之后开麦听回应的时长（ms） */
  readonly listenMs: number;
}

export const DEFAULT_PROACTIVE: ProactiveOptions = {
  listenMs: 8_000,
};

/** `greet` / `chatter` → 一次主动开口的做法；其余动作返回 `null`。 */
export function planProactive(
  move: PetMove,
  caps: DeviceCapabilities,
  options: ProactiveOptions = DEFAULT_PROACTIVE,
): ProactivePlan | null {
  if (move.kind !== 'greet' && move.kind !== 'chatter') {
    return null;
  }
  return {
    kind: move.kind,
    look: canCaptureUnprompted(caps, 'glance') ? 'glance' : null,
    listenMs: caps.listenStart ? options.listenMs : null,
  };
}

function minutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

/**
 * 交给 agent 的那句话。
 *
 * 明确标成**系统提示**：这一轮不是用户说的，模型不该回「你说什么？」。
 * 有图时让它从画面里找话题，没图时别假装看见了。
 */
export function proactivePrompt(move: PetMove, withImage: boolean): string {
  const look = withImage
    ? '附了一张眼镜刚拍到的画面，可以从画面里找个话题，但别像在念图片说明。'
    : '这次没有画面，不要假装看见了什么。';
  if (move.kind === 'greet') {
    return `（系统提示，不是用户说的话：用户刚把眼镜戴回来，离开了大约 ${minutes(move.awayMs)} 分钟。`
      + `主动打个招呼，一两句，口语。${look}）`;
  }
  if (move.kind === 'chatter') {
    return `（系统提示，不是用户说的话：已经安静了大约 ${minutes(move.idleMs)} 分钟。`
      + `主动搭一句话，一两句，口语；对方没兴趣就别追问。${look}）`;
  }
  return '';
}
