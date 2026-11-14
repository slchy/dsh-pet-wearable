/**
 * 模拟世界：把 `AppSession` 装到虚拟宿主上，并提供声明式脚本的执行能力。
 *
 * 对应 ADR-0002 §3.1–§3.3。**模拟器只喂输入**：心跳、事件后补 tick、话筒占用
 * 全在 `AppSession` 里，这里一行都不抄。
 */
import type { DeviceCapabilities } from '../../devices/primitives.ts';
import { V1_BASELINE } from '../../devices/wire-v1.ts';
import { XIAOMI_GLASSES_CAPABILITIES } from '../../devices/xiaomi.ts';
import { AppSession } from '../../app/session.ts';
import { closeAnnounceMic, speakAnnouncement } from '../../app/announce.ts';
import { DEFAULT_PET_PARAMS, type PetParams } from '../brain/registry.ts';
import type { PetImage } from '../brain/types.ts';
import { VirtualClock } from './clock.ts';
import { SimAgent, SimDevice, SimVoice, type AgentScript, type CaptureBehavior } from './host.ts';
import { TimelineSink, type Timeline } from './timeline.ts';

/**
 * 设备预设。声明式场景只写名字，能力集**引用真实档位**，不另抄一份
 * （ADR-0002 §3.3）。
 *
 * `xiaomi` 的 `presence` 是 `false` —— 这是 `devices.test.ts` 钉住的现状，
 * 所以它正好用来测"设备不报佩戴 ⇒ 永不主动开口"。带佩戴的变体叫 `xiaomi-full`。
 */
export type DevicePreset = 'xiaomi' | 'xiaomi-full' | 'no-camera' | 'no-mic' | 'v2-generic';

export function capabilitiesOf(preset: DevicePreset): DeviceCapabilities {
  switch (preset) {
    case 'xiaomi':
      return XIAOMI_GLASSES_CAPABILITIES;
    case 'xiaomi-full':
      return {
        ...XIAOMI_GLASSES_CAPABILITIES,
        presence: true,
        power: true,
        summon: true,
        listenStart: true,
      };
    case 'no-camera':
      return { ...XIAOMI_GLASSES_CAPABILITIES, presence: true, power: true, summon: true, listenStart: true, capture: {} };
    case 'no-mic':
      return {
        ...XIAOMI_GLASSES_CAPABILITIES,
        presence: true,
        power: true,
        summon: true,
        listenStart: false,
      };
    case 'v2-generic':
      return {
        ...V1_BASELINE,
        audioIn: 'pcm16',
        capture: { glance: { needsUser: false }, detail: { needsUser: false } },
        presence: true,
        power: true,
        summon: true,
        listenStart: true,
        played: true,
      };
  }
}

/** 世界的可调项（对应 ADR-0002 §3.3 的"可配置"一列）。 */
export interface SimWorldConfig {
  /** 拍照行为 */
  readonly capture?: CaptureBehavior;
  /** 回图延迟；默认 800 ms */
  readonly captureLatencyMs?: number;
  /** agent 依次给出的回复 */
  readonly agent?: readonly AgentScript[];
  /** agent 用完脚本后的默认回复 */
  readonly agentFallback?: AgentScript;
  /** 每字朗读耗时；不给就用生产估算 */
  readonly voicePerCharMs?: number;
  /**
   * `listen.start` 之后多久出首帧上行（ms）。
   *
   * 小米真机实测约 620 ms。`null` = 永不上报（测"开麦超时也照常开口"）。
   */
  readonly micOpenLatencyMs?: number | null;
}

export interface SimWorldOptions {
  readonly caps: DeviceCapabilities;
  /** 起始本地小时；默认 12 */
  /** 起始墙钟（一天里的第几分钟）；默认 12:00 */
  readonly startMinute?: number;
  readonly params?: Partial<PetParams>;
  readonly tickMs?: number;
  readonly world?: SimWorldConfig;
  readonly log?: boolean;
}

const GLANCE_IMAGE: PetImage = { mimeType: 'image/jpeg', data: 'glance' };

export class SimWorld {
  readonly clock: VirtualClock;
  readonly sink: TimelineSink;
  readonly voice: SimVoice;
  readonly device: SimDevice;
  readonly agent: SimAgent;
  readonly app: AppSession;

  private readonly startAt: number;
  /** 当前在跑的那次主动开口（给声音事件归属用） */
  private engagementId: string | null = null;
  /** 正在播的后台汇报；`null` = 没有 */
  private announceDone: Promise<void> | null = null;
  private readonly caps: DeviceCapabilities;
  private readonly params: PetParams;
  /** 等首帧上行的人（播报用；宠物走 `AppSession.micOpened()`） */
  private micWaiters: Array<(opened: boolean) => void> = [];

  constructor(options: SimWorldOptions) {
    const startMinute = options.startMinute ?? 12 * 60;
    this.caps = options.caps;
    this.params = { ...DEFAULT_PET_PARAMS, ...options.params };
    this.clock = new VirtualClock(0, startMinute);
    this.startAt = 0;
    this.sink = new TimelineSink(() => ({ t: this.clock.now(), wallHour: this.clock.localHour() }));

    this.agent = new SimAgent(
      this.clock,
      this.sink,
      [...(options.world?.agent ?? [])],
      options.world?.agentFallback ?? { reply: { text: '' } },
    );

    this.voice = new SimVoice(this.clock, this.sink, {
      floorOwner: () => this.app.pet.floor.owner,
      engagementId: () => this.engagementId,
      ...(options.world?.voicePerCharMs === undefined
        ? {}
        : { perCharMs: options.world.voicePerCharMs }),
    });

    this.device = new SimDevice(this.clock, this.sink, {
      behavior: options.world?.capture ?? 'ok',
      latencyMs: options.world?.captureLatencyMs ?? 800,
      image: GLANCE_IMAGE,
      deliver: (id, image) => {
        this.sink.push('device', 'image', { engagementId: id, image });
        this.app.image(id, image);
      },
      // 麦开的证据：`listen.start` 之后过一会儿来首帧上行（ADR-0001 §5.4）
      onListenStart: () => {
        // 显式 `null` 表示"永不上报"，别用 `??` 把 null 当成没填
        const configured = options.world?.micOpenLatencyMs;
        const latency = configured === undefined ? 620 : configured;
        if (latency === null) {
          return;
        }
        this.clock.after(latency, () => {
          this.sink.push('device', 'micOpened', {});
          this.app.micOpened();
          this.resolveMicWaiters(true);
        });
      },
    });

    this.app = new AppSession({
      clock: this.clock,
      caps: options.caps,
      voice: this.voice,
      device: this.device,
      agent: this.agent,
      ...(options.params === undefined ? {} : { params: options.params }),
      ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
      onEvent: (name, fields) => {
        this.observe(name, fields);
      },
      ...(options.log === true ? { log: (line: string) => console.log(`    ${line}`) } : {}),
    });

    this.sink.push('system', 'start', { startMinute });
  }

  /** 时间线（只读快照）。 */
  get timeline(): Timeline {
    return this.sink.events;
  }

  /** 推进到「开局 + `offset` 毫秒」。 */
  async until(offset: number): Promise<void> {
    await this.clock.runUntil(this.startAt + offset, () => !this.app.hasPendingInput());
  }

  async wear(wearing: boolean | null): Promise<void> {
    this.sink.push('device', 'presence', { wearing });
    this.app.deviceEvent({ kind: 'presence', wearing });
    await this.flush();
  }

  async battery(percent: number | null): Promise<void> {
    this.sink.push('device', 'power', { percent });
    this.app.deviceEvent({ kind: 'power', percent });
    await this.flush();
  }

  async tap(opensSession = false): Promise<void> {
    this.sink.push('device', 'summon', { opensSession });
    this.app.deviceEvent({ kind: 'summon', opensSession });
    await this.flush();
  }

  async partial(): Promise<void> {
    this.sink.push('user', 'partial', {});
    this.app.userPartial();
    await this.flush();
  }

  async say(text: string): Promise<void> {
    this.sink.push('user', 'final', { text });
    this.app.userFinal(text);
    this.app.turnEnd();
    await this.flush();
  }

  /**
   * 后台汇报**开始**播：占话筒、出声，但不阻塞调用方。
   *
   * 不能在这里 `await` —— 朗读要等虚拟时钟推进才结束，await 会把时钟锁死。
   * 场景跑完由 {@link settleAnnounce} 收尾。
   */
  startAnnounce(text: string): void {
    // 占话筒先于开麦：让位闸门在 `listen.start` 之前就得生效
    this.app.announce(true);
    this.sink.push('announce', 'start', { text });
    // 和生产同一份顺序（`app/announce.ts`）：能开麦就先开、等首帧，超时照播
    this.announceDone = speakAnnouncement(text, {
      listenStart: this.caps.listenStart,
      micOpenTimeoutMs: this.params.micOpenTimeoutMs,
      listenMs: this.params.listenMs,
      call: (call) => { this.device.call(call); },
      awaitMicOpen: (timeoutMs) => this.waitForMic(timeoutMs),
      speak: (speech) => this.voice.speakAnnounce(speech).then(() => undefined),
    }).then(() => {
      this.sink.push('announce', 'end', { text });
      // 整批播完关麦（与生产同一个函数）
      closeAnnounceMic({ listenStart: this.caps.listenStart, call: (call) => { this.device.call(call); } });
      // 播报出过声：不占最小间隔，但推迟下一次搭话
      this.app.announce(false, true);
      this.announceDone = null;
    });
  }

  /** 麦开的证据到了，或 `listen.stop` 把等待作废。 */
  private resolveMicWaiters(opened: boolean): void {
    const waiters = this.micWaiters;
    this.micWaiters = [];
    for (const waiter of waiters) {
      waiter(opened);
    }
  }

  /**
   * 等首帧上行，最多 `timeoutMs`。
   *
   * 和生产的 `awaitMicOpen` 一样：只等，不自己造证据。证据由 `SimDevice`
   * 在 `listen.start` 之后按 `micOpenLatencyMs` 注入。
   */
  private waitForMic(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (opened: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        cancelTimer();
        this.micWaiters = this.micWaiters.filter((waiter) => waiter !== finish);
        resolve(opened);
      };
      const cancelTimer = this.clock.after(timeoutMs, () => { finish(false); });
      this.micWaiters.push((opened) => { finish(opened); });
    });
  }

  /** 等正在播的那条汇报结束（调用方必须已经把时钟推过它）。 */
  async settleAnnounce(): Promise<void> {
    await this.announceDone;
    await this.flush();
  }

  async close(): Promise<void> {
    this.sink.push('system', 'close', {});
    this.app.close();
    await this.flush();
  }

  dispose(): void {
    this.app.dispose();
  }

  /** 排空微任务，但**不**推进时钟。 */
  async flush(): Promise<void> {
    await this.clock.drain(() => !this.app.hasPendingInput());
  }

  private observe(name: string, fields: Record<string, unknown>): void {
    switch (name) {
      case 'pet.out': {
        const intent = fields as { kind?: string; engagementId?: string; phase?: string; step?: number; context?: { reason?: string } };
        if (intent.kind === 'phase.enter' && intent.engagementId !== undefined && intent.phase !== undefined) {
          this.engagementId = intent.engagementId;
          this.sink.push('pet.out', 'phase.enter', {
            engagementId: intent.engagementId,
            phase: intent.phase,
            step: intent.step,
            reason: intent.context?.reason,
          });
          if (intent.phase === 'compose') {
            this.agent.currentEngagementId = intent.engagementId;
          }
        }
        if (intent.kind === 'end') {
          const end = fields as unknown as {
            record: { id: string; outcome: string; phase: string; reason: string; micOpened?: boolean };
            closeMic?: boolean;
            dismiss?: boolean;
          };
          this.sink.push('pet.out', 'end', {
            id: end.record.id,
            outcome: end.record.outcome,
            phase: end.record.phase,
            reason: end.record.reason,
            micOpened: end.record.micOpened,
            closeMic: end.closeMic === true,
            dismiss: end.dismiss === true,
          });
          this.engagementId = null;
          this.agent.currentEngagementId = null;
        }
        return;
      }
      case 'pet.outcome':
        return;
      default:
        this.sink.push('pet.in', name, fields);
    }
  }
}
