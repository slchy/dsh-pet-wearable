/**
 * 宿主 HTTP 的失败关闭栅栏。
 *
 * 顺序不能颠倒：先自检 Host / Sec-Fetch-Site / Origin，再拦非回环写，
 * 最后才问宿主连接栅栏。栅栏缺失只告警一次并放行已经通过前两步的请求；
 * 栅栏抛错、自检抛错，一律 403。
 *
 * 回环判定看 Host 头里写下的主机名，不看 URL 解析器归一化之后的结果。
 * `0x7f.0.0.1`、`2130706433`、`127.1` 都会被归一成 `127.0.0.1`，
 * 用归一化结果当回环等于把混淆写法放进本机信任域。
 */
import { STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

export interface ConnectionFence {
  requestRejection(req: IncomingMessage): number | boolean | null | undefined;
}

/**
 * 主机名是不是本机。
 *
 * 接受 `localhost`、`*.localhost`、`::1` / `[::1]`，以及四段十进制的 `127.0.0.0/8`。
 * 每段必须是 `0..255`，且不能有前导零。`127.0.0.1.evil.com`、`127.999.0.1` 都不是。
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (typeof hostname !== 'string') return false;
  let host = hostname.trim().toLowerCase();
  if (host.length === 0) return false;
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1).trim();
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0) return false;
  if (host === '::1') return true;
  if (host === 'localhost') return true;
  if (isLocalhostChild(host)) return true;
  return isStrictLoopbackV4(host);
}

export interface HostSecurityOptions {
  /** Optional host connection service providing requestRejection(req) */
  readonly getConnectionFence?: () => ConnectionFence | null;
  /** Extra allowed Host / Host:port entries when host fence is unavailable (e.g. DSHV_TRUSTED_HOSTS) */
  readonly trustedHosts?: readonly string[];
  /** Extra allowed Host / Host:port entries for write requests (e.g. DSHV_ADMIN_HOSTS) */
  readonly adminHosts?: readonly string[];
  /** Called once on missing fence or fence error */
  readonly warn?: (message: string) => void;
}

type WarnKind = 'missing' | 'fence' | 'write';

interface ResolvedHost {
  /** Host 头原文（已确认没有首尾空白）。 */
  readonly raw: string;
  /** 去掉端口后的主机名，IPv6 保留方括号。回环判定只用这个。 */
  readonly presented: string;
  readonly hostUrl: URL;
}

type LoadedFence =
  | { readonly kind: 'missing' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly fence: ConnectionFence };

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class HostSecurityGuard {
  readonly #getConnectionFence: (() => ConnectionFence | null) | undefined;
  readonly #trustedHosts: ReadonlySet<string>;
  readonly #adminHosts: ReadonlySet<string>;
  readonly #warn: ((message: string) => void) | undefined;
  readonly #warned = new Set<WarnKind>();

  constructor(options: HostSecurityOptions = {}) {
    this.#getConnectionFence = options.getConnectionFence;
    this.#trustedHosts = hostSet(options.trustedHosts);
    this.#adminHosts = hostSet(options.adminHosts);
    this.#warn = options.warn;
  }

  /** `null` 放行；否则是要写回的 HTTP 状态码。 */
  rejectionCode(req: IncomingMessage): number | null {
    try {
      return this.#decide(req);
    } catch {
      return 403;
    }
  }

  /** 拒绝时写下状态码并结束响应。返回值表示这次是不是拒绝。 */
  rejectIfNeeded(req: IncomingMessage, res: ServerResponse): boolean {
    const code = this.rejectionCode(req);
    if (code === null) return false;
    res.statusCode = code;
    const phrase = reasonPhrase(code);
    if (phrase !== undefined) res.statusMessage = phrase;
    res.end();
    return true;
  }

  /**
   * 升级请求没有正常的响应对象。拒绝时写一行最小的 HTTP 错误然后拆掉套接字。
   * 返回值表示这次是不是拒绝。
   */
  rejectUpgradeIfNeeded(req: IncomingMessage, socket: Duplex): boolean {
    const code = this.rejectionCode(req);
    if (code === null) return false;
    const phrase = reasonPhrase(code) ?? 'Error';
    const payload = `HTTP/1.1 ${code} ${phrase}\r\nConnection: close\r\n\r\n`;
    try {
      socket.write(payload);
    } catch {
      // 写失败也要把这条升级连接拆掉。
    }
    try {
      socket.destroy();
    } catch {
      // 套接字可能已经结束。
    }
    return true;
  }

  #decide(req: IncomingMessage): number | null {
    const resolved = resolveHost(req);
    if (resolved === null) return 403;

    const loaded = this.#loadFence();
    if (loaded.kind === 'error') return 403;
    if (loaded.kind === 'missing') {
      this.#emit('missing', '宿主连接栅栏不可用。');
    }

    const loopback = isLoopbackHostname(resolved.presented);
    if (!loopback && loaded.kind === 'missing' && !matches(resolved, this.#trustedHosts)) {
      return 403;
    }
    if (isCrossSite(req)) return 403;
    if (!originAllowed(req, resolved.hostUrl)) return 403;
    if (isWriteMethod(req.method) && !loopback && !matches(resolved, this.#adminHosts)) {
      this.#emit('write', '已拒绝非回环写请求：Host 不在 adminHosts 中。');
      return 403;
    }
    if (loaded.kind === 'missing') return null;

    try {
      return interpretFence(loaded.fence.requestRejection(req));
    } catch {
      this.#emit('fence', '宿主连接栅栏出错，已拒绝该请求。');
      return 403;
    }
  }

  #loadFence(): LoadedFence {
    if (this.#getConnectionFence === undefined) return { kind: 'missing' };
    try {
      const fence = this.#getConnectionFence();
      if (fence === null || fence === undefined) return { kind: 'missing' };
      return { kind: 'ready', fence };
    } catch {
      this.#emit('fence', '宿主连接栅栏出错，已拒绝该请求。');
      return { kind: 'error' };
    }
  }

  #emit(kind: WarnKind, message: string): void {
    if (this.#warned.has(kind)) return;
    this.#warned.add(kind);
    try {
      this.#warn?.(message);
    } catch {
      // 告警回调出错也不改变放行或拒绝的结论。
    }
  }
}

function hostSet(entries: readonly string[] | undefined): ReadonlySet<string> {
  const set = new Set<string>();
  if (entries === undefined) return set;
  for (const entry of entries) {
    const normalized = entry.trim().toLowerCase();
    if (normalized.length > 0) set.add(normalized);
  }
  return set;
}

function isLocalhostChild(host: string): boolean {
  if (!host.endsWith('.localhost')) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return false;
  }
  return true;
}

function isStrictLoopbackV4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    const octet = parseOctet(part);
    if (octet === null) return false;
    octets.push(octet);
  }
  return octets[0] === 127;
}

function parseOctet(part: string): number | null {
  if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
  const value = Number(part);
  if (value > 255) return null;
  return value;
}

function resolveHost(req: IncomingMessage): ResolvedHost | null {
  const headers = req.headers;
  if (headers === undefined || headers === null) return null;
  const raw = headers.host;
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > 4096) return null;
  if (raw !== raw.trim()) return null;
  if (/[\u0000-\u0020\u007f]/u.test(raw)) return null;
  if (raw.includes('@') || raw.includes('/') || raw.includes('\\') || raw.includes('?') || raw.includes('#')) {
    return null;
  }

  const presented = presentedHostname(raw);
  if (presented === null) return null;

  let hostUrl: URL;
  try {
    hostUrl = new URL(`http://${raw}`);
  } catch {
    return null;
  }
  if (
    hostUrl.username !== ''
    || hostUrl.password !== ''
    || hostUrl.pathname !== '/'
    || hostUrl.search !== ''
    || hostUrl.hash !== ''
    || hostUrl.host === ''
  ) {
    return null;
  }
  return { raw, presented, hostUrl };
}

function presentedHostname(authority: string): string | null {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 2) return null;
    const rest = authority.slice(end + 1);
    if (rest !== '' && !isPortSuffix(rest)) return null;
    return authority.slice(0, end + 1);
  }
  const colon = authority.indexOf(':');
  if (colon === -1) return authority;
  if (authority.indexOf(':', colon + 1) !== -1) return null;
  const host = authority.slice(0, colon);
  if (host.length === 0 || !isPortSuffix(authority.slice(colon))) return null;
  return host;
}

function isPortSuffix(rest: string): boolean {
  if (!/^:\d{1,5}$/.test(rest)) return false;
  const port = Number(rest.slice(1));
  return port >= 0 && port <= 65535;
}

function matches(resolved: ResolvedHost, allowed: ReadonlySet<string>): boolean {
  if (allowed.size === 0) return false;
  const raw = resolved.raw.toLowerCase();
  const presented = resolved.presented.toLowerCase();
  if (allowed.has(raw) || allowed.has(presented)) return true;
  if (presented.startsWith('[') && presented.endsWith(']')) {
    return allowed.has(presented.slice(1, -1));
  }
  return false;
}

function isCrossSite(req: IncomingMessage): boolean {
  const value: unknown = req.headers?.['sec-fetch-site'];
  if (typeof value === 'string') return value.trim().toLowerCase() === 'cross-site';
  if (!Array.isArray(value)) return false;
  return value.some((item: unknown) => (
    typeof item === 'string' && item.trim().toLowerCase() === 'cross-site'
  ));
}

function originAllowed(req: IncomingMessage, hostUrl: URL): boolean {
  const raw = req.headers?.origin;
  if (raw === undefined) return true;
  if (Array.isArray(raw)) return false;
  const origin = raw.trim();
  if (origin.length === 0 || origin.toLowerCase() === 'null') return true;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (originUrl.host === '') return false;
  return originUrl.host.toLowerCase() === hostUrl.host.toLowerCase();
}

function isWriteMethod(method: string | undefined): boolean {
  return method !== undefined && WRITE_METHODS.has(method.toUpperCase());
}

function interpretFence(verdict: unknown): number | null {
  if (typeof verdict === 'number') {
    if (!Number.isFinite(verdict)) return 403;
    return verdict;
  }
  if (verdict === true) return 403;
  if (verdict === false || verdict === null || verdict === undefined) return null;
  return 403;
}

function reasonPhrase(code: number): string | undefined {
  const known = STATUS_CODES[code];
  if (known !== undefined && known.length > 0) return known;
  return undefined;
}
