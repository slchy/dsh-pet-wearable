/**
 * 配对串：一条能贴进手机的字符串，省掉「手抄 64 位 hex + 输 IP + 输端口」。
 *
 * 格式照 WireGuard / k8s join token 的老路走 —— 一次性、等同密码、只给需要的人。
 * 故意**只带两端都已实现**的字段：`host` / `port` / `token`。
 * 证书指纹（`fp`）留到手机端真的会校验它的那天再加，否则就是「配了但没生效」。
 */

const SCHEME = 'dshpet://pair';

export interface Pairing {
  readonly host: string;
  readonly port: number;
  /** 走 TLS 时手机要严格校验 CA */
  readonly tls: boolean;
  readonly token: string;
  /** 只为提示用：这条配对是给哪台设备的 */
  readonly deviceId: string | null;
}

export function encodePairing(p: Pairing): string {
  // 用 URLSearchParams 而不是手拼：token 可能含 `+` `/` `=` 之类的字符
  const params = new URLSearchParams();
  params.set('host', p.host);
  params.set('port', String(p.port));
  if (p.tls) {
    params.set('tls', '1');
  }
  params.set('token', p.token);
  if (p.deviceId !== null) {
    params.set('device', p.deviceId);
  }
  return `${SCHEME}?${params.toString()}`;
}

export type PairingResult =
  | { readonly ok: true; readonly pairing: Pairing }
  | { readonly ok: false; readonly reason: string };

/** 手机端照这个解析。留在这里可测，别让两边各写一份。 */
export function decodePairing(text: string): PairingResult {
  const trimmed = text.trim();
  if (!trimmed.toLowerCase().startsWith(`${SCHEME}?`)) {
    return { ok: false, reason: `不是配对串：应以 ${SCHEME}? 开头` };
  }
  const params = new URLSearchParams(trimmed.slice(SCHEME.length + 1));
  const host = params.get('host')?.trim() ?? '';
  if (host === '') {
    return { ok: false, reason: '配对串缺 host' };
  }
  const rawPort = params.get('port')?.trim() ?? '';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, reason: `配对串的 port 不是合法端口：${rawPort}` };
  }
  const token = params.get('token')?.trim() ?? '';
  if (token === '') {
    return { ok: false, reason: '配对串缺 token' };
  }
  const device = params.get('device')?.trim() ?? '';
  return {
    ok: true,
    pairing: {
      host,
      port,
      tls: params.get('tls') === '1',
      token,
      deviceId: device === '' ? null : device,
    },
  };
}

/** 打印用：token 太长，屏幕上一眼看不出错，给个可对照的头尾。 */
export function maskToken(token: string): string {
  if (token.length <= 10) {
    return '…';
  }
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
