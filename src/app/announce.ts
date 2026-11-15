/**
 * 播报一条后台汇报：设备能开麦就先开麦、等首帧，再开口。
 *
 * 对应 ADR-0001 §6：播报一开口就要能被插话，所以和宠物的 `listen` 阶段同一套规矩 ——
 * 截止 `micOpenTimeoutMs`，超时照播。关麦是整批播完之后的事，不在这里。
 *
 * 生产（`voice-session.ts`）和模拟器（`pet/sim/world.ts`）共用这一份，
 * 场景测到的就是生产代码的顺序。
 */
import type { DeviceCall } from '../devices/primitives.ts';
import { estimateSpeechMs } from '../pet/brain/registry.ts';

export interface AnnounceDeps {
  /** 设备声明了 `listen.start` */
  readonly listenStart: boolean;
  readonly micOpenTimeoutMs: number;
  /** 说完之后再听多久 */
  readonly listenMs: number;
  readonly call: (call: DeviceCall) => void;
  /** 等首帧上行，最多 `timeoutMs`；`true` = 麦开了 */
  readonly awaitMicOpen: (timeoutMs: number) => Promise<boolean>;
  readonly speak: (text: string) => Promise<void>;
}

/**
 * @returns `micOpened`：开麦成功 `true`、超时 `false`、设备不支持开麦 `null`
 */
export async function speakAnnouncement(
  text: string,
  deps: AnnounceDeps,
): Promise<{ readonly micOpened: boolean | null }> {
  let micOpened: boolean | null = null;
  if (deps.listenStart) {
    deps.call({
      op: 'listen.start',
      maxMs: deps.micOpenTimeoutMs + estimateSpeechMs(text) + deps.listenMs,
    });
    micOpened = await deps.awaitMicOpen(deps.micOpenTimeoutMs);
  }
  await deps.speak(text);
  return { micOpened };
}

/**
 * 整批播报播完之后关麦。
 *
 * 单独一个函数而不是塞进 {@link speakAnnouncement}：一批里可能有好几条，
 * ADR-0001 §6 要求的是**整批**播完再关，不是每条关一次。
 */
export function closeAnnounceMic(deps: Pick<AnnounceDeps, 'listenStart' | 'call'>): void {
  if (deps.listenStart) {
    deps.call({ op: 'listen.stop' });
  }
}
