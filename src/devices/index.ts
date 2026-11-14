/**
 * 设备原语出口 + v1 设备的入参解析。
 *
 * 新协议的设备在 `Hello` 里自报能力（{@link parseCapabilities}），插件不需要
 * 认识型号。型号入参只为**不会自报的 v1 手机**存在：给了 `xiaomi-glasses`
 * 就补上小米的默认能力，不给就是 v1 基线。
 */
import { V1_BASELINE, type V1Phrases } from './wire-v1.ts';
import {
  XIAOMI_GLASSES_CAPABILITIES,
  XIAOMI_GLASSES_MODEL,
  XIAOMI_GLASSES_PHRASES,
} from './xiaomi.ts';
import type { DeviceCapabilities } from './primitives.ts';

export * from './primitives.ts';
export { V1_BASELINE, V1Session, v1FailureCode } from './wire-v1.ts';
export type { V1Phrases, V1StatusResult } from './wire-v1.ts';
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
