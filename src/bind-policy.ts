/**
 * 监听地址的安全判据 —— **纯决策，不做 IO**。
 *
 * 起因：这个进程会在能执行 shell 的 agent 宿主机上跑，并监听一个给手机连的 TCP 口。
 * 在没有这一层之前，`--host 0.0.0.0` + 不配 token + 不配 TLS 会安安静静开一个
 * 明文、免鉴权的全网卡端口。`token` 走的是 `Hello` 里的 JSON，明文传输等于把密钥
 * 喊给链路上所有人听 —— 所以「有 token」和「有 TLS」必须**同时**成立才算及格。
 *
 * 谁调用：
 * - `transport.ts` 在 `server.listen()` **之前**强制调用（唯一的拦截点，插件接线后自动继承）
 * - `driver.ts` 在 `apply()` 里调用（配置一写错就报，不必等接上设备才发现）
 *
 * 判据写在一处，两边不会漂。
 */

/** 非 loopback 地址必须同时具备的两样东西。 */
export type BindRequirement = 'token' | 'tls';

export interface BindSafetyInput {
  /** 要绑的地址。空串按「全网卡」处理（`server.listen(port)` 就是这个语义）。 */
  readonly host: string;
  /** 是否配了 TLS（证书能读到）。 */
  readonly hasTls: boolean;
  /** 是否配了设备 token（鉴权回调存在）。 */
  readonly hasAuth: boolean;
}

export type BindSafety =
  | { readonly ok: true; readonly loopback: boolean }
  | {
    readonly ok: false;
    readonly loopback: false;
    readonly missing: readonly BindRequirement[];
    /** 直接给人看的完整说明（含补救动作）。 */
    readonly message: string;
  };

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * 这个地址是否只通本机。
 *
 * 刻意**不做 DNS 解析**：`0.0.0.0` / `::` / 空串 / 任何具体网卡地址一律算「对外」，
 * 宁可误拒也不误放。`localhost` 当本机处理（改 hosts 指向别处需要 root，那不是这层的威胁模型）。
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === '') {
    return false;
  }
  if (h === 'localhost' || h === 'localhost.') {
    return true;
  }
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') {
    return true;
  }
  return LOOPBACK_V4.test(h);
}

/** 绑定前的一道闸。`ok: false` 时调用方必须**拒绝启动**，不能只打日志。 */
export function checkBindSafety(input: BindSafetyInput): BindSafety {
  if (isLoopbackHost(input.host)) {
    return { ok: true, loopback: true };
  }

  const missing: BindRequirement[] = [];
  if (!input.hasAuth) {
    missing.push('token');
  }
  if (!input.hasTls) {
    missing.push('tls');
  }
  if (missing.length === 0) {
    return { ok: true, loopback: false };
  }

  const shown = input.host.trim() === '' ? '(未指定 = 全网卡)' : input.host.trim();
  const wants: string[] = [];
  if (missing.includes('token')) {
    wants.push('设备 token（`MIAI_TOKENS=<文件>`，每行一个；插件里是 `auth.tokenFile`）');
  }
  if (missing.includes('tls')) {
    wants.push('TLS 证书（`MIAI_TLS_KEY` + `MIAI_TLS_CERT`；插件里是 `tls.keyPath` / `tls.certPath`）');
  }

  return {
    ok: false,
    loopback: false,
    missing,
    message: [
      `拒绝监听 ${shown}：非本机地址必须同时有设备 token 和 TLS，缺 ${missing.join(' 和 ')}。`,
      '  因为 token 是明文写在 Hello 里的，没有 TLS 就等于把密钥公开广播。',
      ...wants.map((w) => `  · 需要 ${w}`),
      '  · 只想本机联调：保持默认 `--host 127.0.0.1` + `adb reverse`，这条判据不管本机地址',
      '  · 有反向代理终结 TLS：把 `--host` 写成 127.0.0.1，让代理连过来',
    ].join('\n'),
  };
}
