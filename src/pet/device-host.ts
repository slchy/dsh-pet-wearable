/**
 * 把设备原语事件（`DeviceEvent`）适配成宠物核心的端口（`ports.ts`）。
 *
 * 这就是 ports.ts 说的「一个适配器」—— 而且是**唯一**一个：任何设备只要会说
 * `presence` / `power` / `summon` 事件，就自动有了宠物端口，不用每台设备各写一份。
 *
 * 设备没声明的能力，对应端口就**缺省**（不是给一个永远 `null` 的端口）：
 * 宠物核心据此走它自己的降级分支（没有佩戴源 = 用连接存活近似）。
 */
import type { DeviceCapabilities, DeviceEvent } from '../devices/primitives.ts';
import type { TapInfo } from './pet-timing.ts';
import type { BatteryPort, PetHost, PresencePort, TouchPort } from './ports.ts';

type Listener<T> = (value: T) => void;

/** 简单的订阅表：退订幂等。 */
class Listeners<T> {
  private readonly set = new Set<Listener<T>>();

  add(fn: Listener<T>): () => void {
    this.set.add(fn);
    return () => { this.set.delete(fn); };
  }

  emit(value: T): void {
    for (const fn of [...this.set]) {
      fn(value);
    }
  }
}

export class DeviceEventHost implements PetHost {
  readonly presence?: PresencePort;
  readonly battery?: BatteryPort;
  readonly touch?: TouchPort;
  readonly now: () => number;

  /** `undefined` = 还没收到过 presence 事件 */
  private wearing: boolean | null | undefined = undefined;
  private percent: number | null = null;
  private readonly presenceListeners = new Listeners<boolean | null>();
  private readonly tapListeners = new Listeners<TapInfo>();

  constructor(caps: DeviceCapabilities, now: () => number) {
    this.now = now;
    if (caps.presence) {
      this.presence = {
        wearing: () => this.wearing ?? null,
        onChange: (fn) => this.presenceListeners.add(fn),
      };
    }
    if (caps.power) {
      this.battery = { level: () => Promise.resolve(this.percent) };
    }
    if (caps.summon) {
      this.touch = { onTap: (fn) => this.tapListeners.add(fn) };
    }
  }

  /**
   * 喂一条设备事件。拍照事件不归这里（收件箱管），原样忽略。
   *
   * 佩戴在这里去重：只在真正翻转时通知（`ports.ts` 要求适配器自己去重）。
   */
  feed(event: DeviceEvent): void {
    switch (event.kind) {
      case 'presence':
        if (this.presence === undefined || event.wearing === this.wearing) {
          return;
        }
        this.wearing = event.wearing;
        this.presenceListeners.emit(event.wearing);
        return;
      case 'power':
        if (this.battery !== undefined) {
          this.percent = event.percent;
        }
        return;
      case 'summon':
        if (this.touch !== undefined) {
          this.tapListeners.emit({ opensSession: event.opensSession === true });
        }
        return;
      default:
        return;
    }
  }
}
