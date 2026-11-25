/**
 * 一条连接上的设备状态与下行原语。
 *
 * 电量 / 佩戴只在字段真有值时合并。帧分发把 v1 状态帧和 v2 Event 收成同一种
 * `DeviceEvent`，再交给宠物环和收件箱。`listen.start` 的相位由 {@link MicController}
 * 决定：能力不够或连接正在关，都不许先进入 `opening`。
 */
import type { AppDeviceEvent } from '../app/session.ts';
import { EVENTS } from '../events.ts';
import {
  captureMode,
  encodeV2Call,
  parseV2Event,
  supportsCall,
  type CaptureIntent,
  type DeviceCall,
  type DeviceCapabilities,
  type DeviceEvent,
  type DeviceLink,
  type V1Session,
} from '../devices/index.ts';
import type { CaptureRequest, PhotoOutcome } from '../photo-inbox.ts';
import type { Connection } from '../transport.ts';
import type { VoicePipelineMode } from '../pipeline-mode.ts';
import type { MicController } from './mic-phase.ts';

/**
 * 电量帧合并。
 *
 * 只在字段**真有值**时更新。`undefined` 是没带这个字段；线上 `parseV2Event`
 * 还会把缺字段收成 `null`。两种空都不能盖掉上一次已经记下的电量 / 充电。
 */
export function mergePowerReading(
  current: { readonly percent: number | null; readonly charging: boolean | null },
  event: { readonly percent?: number | null; readonly charging?: boolean | null },
): { readonly percent: number | null; readonly charging: boolean | null } {
  return {
    percent: event.percent !== undefined && event.percent !== null ? event.percent : current.percent,
    charging: event.charging !== undefined && event.charging !== null ? event.charging : current.charging,
  };
}

/** 设备状态要往对话层 / 档案送的那几步。晚绑定：构造期这些对象还没齐。 */
export interface DeviceReadingPorts {
  readonly conn: Connection;
  readonly link: DeviceLink;
  readonly caps: DeviceCapabilities;
  readonly v1: V1Session | null;
  readonly mic: MicController;
  pipelineMode(): VoicePipelineMode | undefined;
  archive(name: string, fields?: Record<string, unknown>): void;
  /** 拍照事件交给收件箱。返回要念给用户的那句，没有就 `null`。 */
  onCapture(event: DeviceEvent): string | null;
  appDevice(event: AppDeviceEvent): void;
  enqueueAnnounce(speech: string): void;
  speakCanned(speech: string): void;
  devicePlayed(): void;
  requestPhoto(request: CaptureRequest): Promise<PhotoOutcome>;
  forget(id: string): void;
}

/** 电量、佩戴、呼叫下发和工具口拍照序号。 */
export class DeviceReading {
  private readonly ports: DeviceReadingPorts;
  private powerPercent: number | null = null;
  private charging: boolean | null = null;
  private wearingState: boolean | null = null;
  /** 工具口拍照用的序号，保证 `id` 在一条连接内唯一 */
  private toolSeq = 0;

  constructor(ports: DeviceReadingPorts) {
    this.ports = ports;
  }

  get wearing(): boolean | null {
    return this.wearingState;
  }

  /**
   * 把一次 `DeviceCall` 真正下发出去。
   *
   * - 能力先挡：设备没声明的操作不发（`supportsCall`）
   * - v2 连接原样发 JSON（`Call` 帧）
   * - v1 连接经垫片翻成控制串；v1 表达不了的（如 `listen.start`）明确记日志跳过
   */
  sendCall(call: DeviceCall): boolean {
    // 关麦 / 已关：拒绝再发 listen.start。失败也不能先进入 opening，
    // 否则等首帧的人会一直耗到 micOpenTimeoutMs。
    if (call.op === 'listen.start' && this.ports.mic.listenStartBlocked()) {
      this.ports.archive(EVENTS.ctlSkip, { op: call.op, why: 'closing' });
      console.log('  控制    ✗ 连接正在关闭，拒绝 listen.start');
      return false;
    }
    if (!supportsCall(this.ports.caps, call)) {
      this.ports.archive(EVENTS.ctlSkip, { op: call.op, why: 'unsupported' });
      console.log(`  控制    ✗ 设备未声明 ${call.op}，已跳过`);
      return false;
    }
    if (this.ports.v1 === null) {
      const json = encodeV2Call(call);
      this.ports.archive(EVENTS.callSend, { json });
      this.ports.conn.sendCall(json);
    } else {
      const text = this.ports.v1.encode(call);
      if (text === null) {
        this.ports.archive(EVENTS.ctlSkip, { op: call.op, why: 'v1-cannot-express' });
        console.log(`  控制    ✗ v1 无法表达 ${call.op}，已跳过`);
        return false;
      }
      this.sendControl(text);
    }
    this.ports.mic.noteListenSent(call);
    return true;
  }

  /** 下发控制串并记进档案：每次下发都能在时间线上对到当时的音频位置 */
  sendControl(text: string): void {
    this.ports.archive(EVENTS.ctlSend, { text });
    this.ports.conn.sendControl(text);
  }

  /**
   * 给这一轮附上的设备现状。
   *
   * 模型看不到上行事件流，这行是它唯一知道「电量多少、戴没戴」的途径。
   * 没有数据时返回 `undefined`（而不是空串），让调用方干净地略过。
   */
  deviceNote(): string | undefined {
    const parts: string[] = [];
    if (this.wearingState !== null) {
      parts.push(this.wearingState ? '用户正戴着' : '用户摘下了');
    }
    if (this.powerPercent !== null) {
      parts.push(`电量 ${this.powerPercent}%${this.charging ? '，充电中' : ''}`);
    }
    return parts.length === 0 ? undefined : `设备现状：${parts.join('；')}`;
  }

  /**
   * v1 的 `Status` 帧。
   *
   * `hq_armed` / `hq_image` / `hq_failed` 由垫片翻译成原语事件；
   * 收件箱只认 `DeviceEvent`。不认识的事件丢掉，不许盖掉已经记下的电量。
   */
  onStatus(payload: Buffer): void {
    const v1 = this.ports.v1;
    if (v1 === null) {
      console.log('  ✗ v2 连接收到 v1 状态帧，已忽略（v2 用 Event 帧）');
      return;
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
    } catch {
      console.error(`  ✗ 状态帧不是合法 JSON：${payload.toString('utf8').slice(0, 120)}`);
      return;
    }
    const name = typeof json['ev'] === 'string' ? json['ev'] : '';
    this.ports.archive(EVENTS.statusRecv, { name, raw: JSON.stringify(json).slice(0, 200) });

    // v1 的状态帧没有请求 id：垫片按它记着的在途请求补上
    const result = v1.status(json);
    if (!result.known) {
      console.log(`  ✗ 未知状态事件 ${JSON.stringify(name)}，已忽略`);
      return;
    }
    if (result.event !== null) {
      this.onDeviceEvent(result.event);
    }
  }

  /** v2 的 `Event` 帧：JSON `DeviceEvent`。 */
  onV2Event(payload: Buffer): void {
    if (this.ports.link.proto !== 2) {
      console.log('  ✗ v1 连接收到 v2 Event 帧，已忽略');
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(payload.toString('utf8'));
    } catch {
      console.error(`  ✗ Event 帧不是合法 JSON：${payload.toString('utf8').slice(0, 120)}`);
      return;
    }
    this.ports.archive(EVENTS.eventRecv, { raw: JSON.stringify(raw).slice(0, 200) });
    const event = parseV2Event(raw);
    if (event === null) {
      console.log(`  ✗ 不认识的设备事件 ${JSON.stringify(raw).slice(0, 120)}，已忽略`);
      return;
    }
    this.onDeviceEvent(event);
  }

  /** 一条原语事件：拍照的归收件箱，佩戴 / 电量 / 招呼归宠物环。 */
  onDeviceEvent(event: DeviceEvent): void {
    switch (event.kind) {
      case 'capture.waiting':
      case 'capture.failed': {
        const say = this.ports.onCapture(event);
        if (say !== null) {
          // 设备已就绪，现在轮到人动手 —— Pure Live 走 omni 播报，不调外部 TTS
          if (this.ports.pipelineMode() === 'live') {
            this.ports.enqueueAnnounce(say);
          } else {
            this.ports.speakCanned(say);
          }
        }
        return;
      }
      case 'presence':
        this.wearingState = event.wearing;
        // 「事件后补 tick」在 AppSession 里（ADR-0002 §3.1）
        this.ports.appDevice(event);
        return;
      case 'power': {
        const next = mergePowerReading(
          { percent: this.powerPercent, charging: this.charging },
          event,
        );
        this.powerPercent = next.percent;
        this.charging = next.charging;
        // 宠物只认电量。缺 percent 时传留下的值，避免 null 把宠物侧也清掉。
        this.ports.appDevice({ kind: 'power', percent: this.powerPercent });
        return;
      }
      case 'summon':
        this.ports.appDevice(event);
        return;
      case 'played':
        // 设备说播完了：有 `played` 能力的设备靠它离开 speaking（时长估算是**下限**，
        // 回执只能延后；真机上见过设备在最后一批字节收到时就回执）
        this.ports.devicePlayed();
        this.ports.archive(EVENTS.devicePlayed);
        return;
      default: {
        const unexpected: never = event;
        return unexpected;
      }
    }
  }

  /** 工具口的拍照请求：要的意图没有就退到另一档。 */
  async requestToolCapture(want: CaptureIntent): Promise<PhotoOutcome> {
    const other: CaptureIntent = want === 'glance' ? 'detail' : 'glance';
    const intent = captureMode(this.ports.caps, want) !== null ? want : other;
    const mode = captureMode(this.ports.caps, intent);
    if (mode === null) {
      return { ok: false, failure: { code: 'unsupported' } };
    }
    this.toolSeq += 1;
    const request: CaptureRequest = {
      id: `tool-${this.toolSeq}`,
      intent,
      needsUser: mode.needsUser,
    };
    try {
      return await this.ports.requestPhoto(request);
    } finally {
      this.ports.forget(request.id);
    }
  }
}
