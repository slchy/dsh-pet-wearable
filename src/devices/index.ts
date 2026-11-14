/**
 * 设备原语出口 + v1 设备的入参解析。
 *
 * v2 设备在 `Hello` 里自报能力（{@link negotiateV2}），插件不需要
 * 认识型号。型号入参只为**不会自报的 v1 手机**存在：给了 `xiaomi-glasses`
 * 就补上小米的默认能力，不给就是 v1 基线。
 */
import { V1_BASELINE, V1Session, type V1Phrases } from './wire-v1.ts';
import { negotiateV2 } from './wire-v2.ts';
import {
  XIAOMI_GLASSES_CAPABILITIES,
  XIAOMI_GLASSES_MODEL,
  XIAOMI_GLASSES_PHRASES,
} from './xiaomi.ts';
import type { DeviceCapabilities } from './primitives.ts';

export * from './primitives.ts';
export { V1_BASELINE, V1Session, v1FailureCode } from './wire-v1.ts';
export type { V1Phrases, V1StatusResult } from './wire-v1.ts';
export {
  encodeV2CaptureImage,
  encodeV2Call,
  negotiateV2,
  parseV2CaptureImage,
  parseV2Event,
  V2_PROTO,
  V2_WELCOME,
} from './wire-v2.ts';
export { XIAOMI_GLASSES_CAPABILITIES, XIAOMI_GLASSES_MODEL, XIAOMI_GLASSES_PHRASES } from './xiaomi.ts';

/** 一台 v1 设备：能力 + 垫片代说的话。 */
export interface V1Device {
  /** 日志与档案里显示的名字 */
  readonly label: string;
  readonly capabilities: DeviceCapabilities;
  readonly phrases: V1Phrases;
}

export const GENERIC_V1_DEVICE: V1Device = {
  label: 'generic-v1',
  capabilities: V1_BASELINE,
  phrases: {},
};

export const XIAOMI_V1_DEVICE: V1Device = {
  label: XIAOMI_GLASSES_MODEL,
  capabilities: XIAOMI_GLASSES_CAPABILITIES,
  phrases: XIAOMI_GLASSES_PHRASES,
};

const DEVICES: ReadonlyMap<string, V1Device> = new Map([
  [XIAOMI_GLASSES_MODEL, XIAOMI_V1_DEVICE],
  ['xiaomi', XIAOMI_V1_DEVICE],
  ['mijia', XIAOMI_V1_DEVICE],
]);

/** `--device` 可用的取值（用法提示用）。 */
export const DEVICE_MODELS: readonly string[] = [XIAOMI_GLASSES_MODEL];

/**
 * 型号入参 → v1 设备。
 *
 * 空串与未知型号一律回落 v1 基线，**不报错** —— 型号只是给不会自报的手机补默认值。
 */
export function resolveV1Device(model?: string): V1Device {
  const key = (model ?? '').trim().toLowerCase();
  return DEVICES.get(key) ?? GENERIC_V1_DEVICE;
}

/** 一条连接最终说哪个版本、用什么能力。 */
export interface DeviceLink {
  readonly proto: 1 | 2;
  /** 日志与档案里显示的名字 */
  readonly label: string;
  readonly capabilities: DeviceCapabilities;
  /** v1 垫片；v2 连接为 `null` */
  readonly v1: V1Session | null;
}

/**
 * 握手决策：`Hello` 自报了合法的 v2 能力就走 v2，否则按型号提示走 v1。
 *
 * - 没发 `Hello`（老手机、没配鉴权）→ v1
 * - `proto:1`，或 `proto:2` 但能力不合法 → v1（**降级，不拒绝**：向下兼容优先）
 * - v2 时型号提示被忽略：设备自己说的比部署方猜的准
 */
export function resolveDeviceLink(
  hello: { readonly proto?: number; readonly deviceId?: string; readonly capabilities?: unknown } | null,
  model?: string,
): DeviceLink {
  const caps = negotiateV2(hello);
  if (caps !== null) {
    return {
      proto: 2,
      label: hello?.deviceId === undefined ? 'v2-device' : hello.deviceId,
      capabilities: caps,
      v1: null,
    };
  }
  const device = resolveV1Device(model);
  return {
    proto: 1,
    label: device.label,
    capabilities: device.capabilities,
    v1: new V1Session(device.phrases),
  };
}

/** 启动横幅里的一行能力摘要。 */
export function describeCapabilities(caps: DeviceCapabilities): string {
  const capture = (['glance', 'detail'] as const)
    .filter((intent) => caps.capture[intent] !== undefined)
    .map((intent) => `${intent}${caps.capture[intent]?.needsUser === true ? '(等用户)' : ''}`)
    .join('/') || '无';
  const flags = (['presence', 'power', 'summon', 'listenStart', 'played'] as const)
    .filter((key) => caps[key])
    .join(' ') || '无';
  return `上行 ${caps.audioIn}；拍照 ${capture}；上报 ${flags}；忽略短语 ${caps.ignorePhrases.length} 条`;
}
