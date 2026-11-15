/**
 * 证书到期检查。
 *
 * <h2>为什么需要它</h2>
 *
 * 现网那张自签证书 **2027-02-11 到期**。到期当天服务端照常启动、照常监听，
 * 但**每一次 TLS 握手都会失败** —— 客户端只会看到"连不上"，服务端日志里
 * 一个字都没有。这类故障在出事之前是完全静默的，所以至少要在能用的时候
 * 提前喊出来。
 *
 * 只做提醒，**不拒绝启动**：拒绝会让 systemd 反复重启、日志被刷掉，而且一旦
 * 哪天需要临时用明文跑本地调试也会被误伤。喊得足够响就够了。
 */
import { X509Certificate } from 'node:crypto';

/** 提前多久开始提醒（天）。 */
export const CERT_WARN_DAYS = 30;

/** 提前多久算"紧急"（天）。 */
export const CERT_URGENT_DAYS = 7;

export interface CertExpiry {
  /** 证书的 `notAfter`（毫秒时间戳） */
  readonly notAfterMs: number;
  /** 还剩几天（向下取整；已过期为负） */
  readonly daysLeft: number;
}

/**
 * 读证书的到期时间。解析不了返回 `null`（不抛 —— 证书坏了是另一条错误路径，
 * 由 TLS 握手自己去失败，这里只负责到期提醒）。
 */
export function certExpiry(pem: Buffer | string): CertExpiry | null {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    return null;
  }
  const notAfterMs = Date.parse(cert.validTo);
  if (!Number.isFinite(notAfterMs)) {
    return null;
  }
  return {
    notAfterMs,
    daysLeft: Math.floor((notAfterMs - Date.now()) / 86_400_000),
  };
}

/**
 * 按到期时间生成要打在启动日志里的提醒；还剩很久就返回 `null`（不占日志）。
 *
 * 和 {@link expiryWarning} 分开是为了可测：阈值判断是纯数字逻辑，
 * 不需要为了造一张证书而依赖 openssl。
 *
 * @param notAfterMs 证书的 `notAfter`（毫秒时间戳）
 * @param now 判据用的"现在"，测试注入
 */
export function warningFor(notAfterMs: number, now: number = Date.now()): string[] | null {
  const days = Math.floor((notAfterMs - now) / 86_400_000);
  const when = new Date(notAfterMs).toISOString().slice(0, 10);
  if (days <= 0) {
    return [
      `✗ TLS 证书已经过期（notAfter=${when}）`,
      '  从现在起**每一次 TLS 握手都会失败**，客户端只会看到"连不上"。',
      '  换证书：python scripts/gen_local_ca.py / gen_server_pin.py（见老仓 README「想开 TLS？」）',
    ];
  }
  if (days <= CERT_URGENT_DAYS) {
    return [
      `⚠ TLS 证书只剩 ${days} 天（notAfter=${when}）—— 到期当天所有客户端会同时连不上。`,
    ];
  }
  if (days <= CERT_WARN_DAYS) {
    return [`TLS 证书 ${when} 到期（还剩 ${days} 天），记得安排轮换。`];
  }
  return null;
}

/**
 * 生成要打在启动日志里的提醒；还剩很久、或证书解析不了，返回 `null`。
 *
 * @param pem 证书内容
 * @param now 判据用的"现在"，测试注入
 */
export function expiryWarning(pem: Buffer | string, now: number = Date.now()): string[] | null {
  const info = certExpiry(pem);
  return info === null ? null : warningFor(info.notAfterMs, now);
}
