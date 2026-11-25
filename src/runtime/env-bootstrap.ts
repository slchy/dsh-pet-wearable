/**
 * 启动期环境：`.env`、TLS 证书、设备 token。
 *
 * 配置错误**抛异常**，不 `process.exit`。CLI 在 `main()` 里接住再退出；
 * 插件宿主跑在别人的进程里，退出会把宿主一起带走。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expiryWarning } from '../tls-cert.ts';
import {
  describeTokenProblem,
  readTokenFile,
  tokenFilePath,
  TokenGate,
} from '../tokens.ts';

/**
 * 读 `cloud/.env`（KEY=VALUE，忽略 # 注释与空行）。
 *
 * 不引依赖：格式就这么点。**已存在的环境变量优先**，所以命令行临时覆盖仍然有效。
 */
export function loadDotEnv(): number {
  const path = join(process.cwd(), '.env');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return 0;
  }
  let count = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      count += 1;
    }
  }
  if (count > 0) {
    console.log(`凭据    ${path}（${count} 项）`);
  }
  return count;
}

/**
 * 证书从文件读，路径只走环境变量 —— 部署细节不进源码。
 *
 * **配置错误抛异常，不退出进程**：插件宿主（`dsh-voice-web`）跑在 dsh 进程里，
 * `process.exit` 会把整个宿主带走。CLI 在 `main()` 里接住再转 `fail`，
 * 退出码与提示一字不变。
 */
export function loadTls(): { key: Buffer; cert: Buffer } | undefined {
  const keyPath = process.env['MIAI_TLS_KEY'] ?? '';
  const certPath = process.env['MIAI_TLS_CERT'] ?? '';
  if (!keyPath || !certPath) {
    // 只给一半是配错了，不是「没配」—— 静默降级成明文会让人以为已经加密了
    if (keyPath || certPath) {
      const given = keyPath ? 'MIAI_TLS_KEY' : 'MIAI_TLS_CERT';
      const absent = keyPath ? 'MIAI_TLS_CERT' : 'MIAI_TLS_KEY';
      throw new Error(`只给了 ${given}，缺 ${absent}：TLS 要么两个都给，要么都不给`);
    }
    return undefined;
  }
  try {
    const cert = readFileSync(certPath);
    // 到期检查：过期的证书服务端照常启动、照常监听，只是每一次握手都失败 ——
    // 客户端只看到「连不上」，日志里一个字都没有。所以在这里喊出来。
    for (const line of expiryWarning(cert) ?? []) {
      console.warn(`  ${line}`);
    }
    return { key: readFileSync(keyPath), cert };
  } catch (error) {
    throw new Error(`TLS 证书读不到：${(error as Error).message}`);
  }
}

/**
 * 设备鉴权：`MIAI_TOKENS` 指向一个文件，每行 `token` 或 `token:deviceId`。
 *
 * - 不配就**不鉴权**（只可能用于本机地址 —— 由 `bind-policy.ts` 把关）
 * - 配了就必须首帧 `Hello`，且 token 要过强度校验（见 `tokens.ts`）
 * - 文件变了自动重读，**吊销不必重启进程**
 * - 写了 `token:deviceId` 就是真绑定：`Hello.deviceId` 对不上同样拒绝
 *
 * 与 {@link loadTls} 一样：配置错误**抛异常**，由调用方决定是退出还是收下
 * （插件宿主不能退出）。
 */
export function loadAuthenticator(log: (line: string) => void): ((hello: { deviceId?: string; token?: string }) => boolean) | undefined {
  const path = process.env['MIAI_TOKENS'] ?? '';
  if (!path.trim()) return undefined;

  const resolved = tokenFilePath(path);
  // 启动时就报出弱/错 token，别等到设备连上来才发现「配了等于没配」
  const { entries, bad } = readTokenFile(resolved);
  for (const item of bad) {
    throw new Error(
      `${resolved} 第 ${item.line} 行不合格：${describeTokenProblem(item.raw, item.problem)}\n`
      + '（要重新发一个：node src/pair.ts new --device <id>）',
    );
  }
  if (entries.length === 0) {
    throw new Error(`${resolved} 里没有任何可用的 token`);
  }

  const gate = new TokenGate(resolved, log);
  console.log(`鉴权      ${entries.length} 个设备 token（来自 ${resolved}，改动会自动重读）`);
  return (hello) => typeof hello.token === 'string' && gate.match(hello.token, hello.deviceId) !== null;
}
