/**
 * v2 线协议：原语直接上线，不再翻译成控制串。
 *
 * **向下兼容**是这样做到的：帧头、`Audio` / `Image` / `Wake` / `Ping` / `Pong` / `Control`
 * 与 v1 完全一样，v2 只**新增**帧类型，不改任何旧帧的含义。
 *
 * ```text
 * 设备 ── Hello{proto:2, capabilities} ──▶ 服务端
 *      ◀── Welcome{proto:2} ──────────── 认了：之后用 Call / Event / CaptureImage
 *      （没有 Welcome）                   老服务端或能力不合法：设备照 v1 说话
 * ```
 *
 * - 老手机（不发 Hello、或 `proto:1`）→ 服务端走 v1 垫片，行为不变
 * - v2 设备连老服务端 → 老服务端不认识 `capabilities`、不回 `Welcome`，设备退回 v1
 * - 服务端只在发过 `Welcome` 之后才发 `Call`，所以 v1 手机永远收不到不认识的帧
 *
 * | 方向 | type | 名字 | payload |
 * |---|---|---|---|
 * | 下行 | 3 | `Call` | UTF-8 JSON `DeviceCall` |
 * | 下行 | 4 | `Welcome` | UTF-8 JSON `{"proto":2}` |
 * | 上行 | 7 | `Event` | UTF-8 JSON `DeviceEvent` |
 * | 上行 | 8 | `CaptureImage` | `[idLen:u8][id:UTF-8][JPEG]` |
 *
 * 用户自己拍的图（不属于任何请求）仍走 v1 的 `Image`。
 */
import {
  parseCapabilities,
  type CaptureErrorCode,
  type DeviceCall,
  type DeviceCapabilities,
  type DeviceEvent,
} from './primitives.ts';

/** 本实现说的协议版本 */
export const V2_PROTO = 2;

/** `Welcome` 帧的内容 */
export const V2_WELCOME = JSON.stringify({ proto: V2_PROTO });

/**
 * 握手：`Hello` 里有 `proto >= 2` 且能力合法 → 走 v2。
 *
 * 更高的 `proto` 也按 2 说（`Welcome` 里回 2，设备据此降到 2）。
 * 能力不合法时返回 `null`：**不发 `Welcome`**，设备会退回 v1 —— 宁可降级也不猜。
 */
export function negotiateV2(
  hello: { readonly proto?: number; readonly capabilities?: unknown } | null,
): DeviceCapabilities | null {
  if (hello === null || hello.proto === undefined || hello.proto < V2_PROTO) {
    return null;
  }
  return parseCapabilities(hello.capabilities);
}

/** `DeviceCall` → `Call` 帧的 payload。 */
export function encodeV2Call(call: DeviceCall): string {
  return JSON.stringify(call);
}

const ERROR_CODES: ReadonlySet<string> = new Set<CaptureErrorCode>([
  'unsupported', 'busy', 'timeout', 'cancelled', 'failed',
]);

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * `Event` 帧（已解析的 JSON）→ 原语事件。
 *
 * 不认识的 `kind` 或缺必填字段 → `null`（调用方记日志丢弃）；
 * 不认识的失败码按 `failed` 处理 —— 失败总归是失败，不该因为码新就当没发生。
 */
export function parseV2Event(raw: unknown): DeviceEvent | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  switch (o['kind']) {
    case 'presence':
      // `wearing` 必须显式给出：`null` 是「读不到」，缺字段是坏帧
      if (!('wearing' in o)) {
        return null;
      }
      return { kind: 'presence', wearing: nullableBoolean(o['wearing']) };
    case 'power': {
      const percent = o['percent'];
      return {
        kind: 'power',
        percent: typeof percent === 'number' && percent >= 0 && percent <= 100 ? percent : null,
        charging: nullableBoolean(o['charging']),
      };
    }
    case 'summon':
      return o['opensSession'] === true ? { kind: 'summon', opensSession: true } : { kind: 'summon' };
    case 'played':
      return { kind: 'played' };
    case 'capture.waiting': {
      const id = optionalString(o['id']);
      if (id === undefined) {
        return null;
      }
      const say = optionalString(o['say']);
      return { kind: 'capture.waiting', id, ...(say === undefined ? {} : { say }) };
    }
    case 'capture.failed': {
      const id = optionalString(o['id']);
      if (id === undefined) {
        return null;
      }
      const rawCode = o['code'];
      const code = (typeof rawCode === 'string' && ERROR_CODES.has(rawCode)
        ? rawCode
        : 'failed') as CaptureErrorCode;
      const say = optionalString(o['say']);
      return { kind: 'capture.failed', id, code, ...(say === undefined ? {} : { say }) };
    }
    default:
      return null;
  }
}

/** `CaptureImage` 帧的 payload：`[idLen:u8][id][JPEG]`。 */
export function encodeV2CaptureImage(id: string, jpeg: Buffer): Buffer {
  const idBytes = Buffer.from(id, 'utf8');
  if (idBytes.length === 0 || idBytes.length > 255) {
    throw new Error(`capture id 长度必须在 1..255 字节：${idBytes.length}`);
  }
  return Buffer.concat([Buffer.from([idBytes.length]), idBytes, jpeg]);
}

/** 解 `CaptureImage`；格式不对返回 `null`。 */
export function parseV2CaptureImage(payload: Buffer): { id: string; jpeg: Buffer } | null {
  const idLength = payload[0];
  if (idLength === undefined || idLength === 0 || payload.length < 1 + idLength) {
    return null;
  }
  return {
    id: payload.subarray(1, 1 + idLength).toString('utf8'),
    jpeg: payload.subarray(1 + idLength),
  };
}
