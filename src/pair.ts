#!/usr/bin/env node
/**
 * 设备配对的管理口 —— **初始化的人负责生成**。
 *
 *   node src/pair.ts new  [--device <id>] [--host <addr>] [--port <n>] [--tls]
 *   node src/pair.ts list
 *   node src/pair.ts revoke --device <id> | --token <t>
 *   node src/pair.ts check <配对串>      # 验一条串能不能用（不碰服务端）
 *
 * 共同参数：`--file <path>`（默认取 `MIAI_TOKENS`，再退到 `./tokens.txt`）。
 *
 * 为什么要有这个命令，而不是让部署方自己想一串字符串：
 * - 想出来的字符串几乎必然是低熵的，而且会被复制到聊天记录里
 * - 手抄 64 位 hex 进手机必然出错，所以顺带产出**配对串**
 * - 吊销必须是个动作，不能是"去文件里删一行然后重启"
 */
import { checkBindSafety } from './bind-policy.ts';
import { decodePairing, encodePairing, maskToken } from './pairing.ts';
import {
  appendToken,
  classifyToken,
  describeTokenProblem,
  readTokenFile,
  revokeTokens,
  tokenFilePath,
  type TokenEntry,
} from './tokens.ts';

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(2);
}

function arg(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

function has(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

function printEntries(entries: readonly TokenEntry[], path: string): void {
  if (entries.length === 0) {
    console.log(`（${path} 里没有任何设备 token；远端监听会被拒绝）`);
    return;
  }
  console.log(`${path} 里 ${entries.length} 个设备 token：\n`);
  console.log('  #  设备             token（打码）');
  entries.forEach((entry, index) => {
    console.log(`  ${String(index + 1).padEnd(2, ' ')} ${(entry.deviceId ?? '(未绑定)').padEnd(16, ' ')} ${maskToken(entry.token)}`);
  });
  console.log('\n完整 token 不会在这里显示 —— 它只在生成时打印一次。');
  console.log('丢了就吊销重发：node src/pair.ts revoke --device <id> && node src/pair.ts new --device <id>');
}

const argv = process.argv.slice(2);
const sub = argv[0] ?? '';
const file = tokenFilePath(arg(argv, '--file'));

switch (sub) {
  case 'new': {
    const deviceId = arg(argv, '--device')?.trim() || null;
    const host = arg(argv, '--host')?.trim() || '127.0.0.1';
    const portRaw = arg(argv, '--port') ?? '8766';
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      fail(`--port 不是合法端口：${portRaw}`);
    }
    const tls = has(argv, '--tls');

    // 本机与否只走 checkBindSafety（内部是 isLoopbackHost：localhost / ::1 / 127.*）。
    // 不要再手写 host !== '127.0.0.1'，那会把 localhost 和 ::1 误报成「非本机还没开 TLS」。
    const safety = checkBindSafety({ host, hasTls: tls, hasAuth: true });
    if (!safety.ok) {
      console.warn(`! ${safety.message}\n  （token 照样会生成，但该地址现在还绑不上）\n`);
    }

    let token: string;
    try {
      ({ token } = appendToken(file, deviceId));
    } catch (error) {
      fail((error as Error).message);
    }

    const uri = encodePairing({ host, port, tls, token, deviceId });
    console.log(`✔ 已生成并追加到 ${file}`);
    console.log(`  设备      ${deviceId ?? '(未绑定 deviceId)'}`);
    console.log(`  监听      ${tls ? 'tls' : 'tcp'}://${host}:${port}\n`);
    console.log('配对串（贴进手机 App 的「配对」框；**等同密码**，别再转贴到聊天记录）：\n');
    console.log(`  ${uri}\n`);
    console.log('这是 token 唯一一次明文出现。服务端下次连上时会自动读到。');
    break;
  }

  case 'list': {
    try {
      const { entries, bad } = readTokenFile(file);
      printEntries(entries, file);
      if (bad.length > 0) {
        console.log(`\n⚠ ${bad.length} 行被忽略（这些行当前**不生效**）：`);
        for (const item of bad) {
          console.log(`  第 ${item.line} 行 ${maskToken(item.raw)}：${describeTokenProblem(item.raw, item.problem)}`);
        }
        // 有坏行就以非零退出：部署脚本与 CI 用这条命令当闸，
        // 不能因为"文件存在"就放行 —— 新代码启动时会直接拒绝这些行。
        process.exitCode = 2;
      }
    } catch (error) {
      fail(`读不到 ${file}：${(error as Error).message}\n先跑 node src/pair.ts new`);
    }
    break;
  }

  case 'revoke': {
    const deviceId = arg(argv, '--device')?.trim();
    const token = arg(argv, '--token')?.trim();
    if ((deviceId === undefined) === (token === undefined)) {
      fail('revoke 要二选一：--device <id> 或 --token <token>');
    }
    try {
      const { removed } = revokeTokens(file, deviceId !== undefined ? { deviceId } : { token: token! });
      console.log(`✔ 已吊销 ${removed.length} 个 token：`);
      for (const entry of removed) {
        console.log(`  ${entry.deviceId ?? '(未绑定)'}  ${maskToken(entry.token)}`);
      }
      console.log('\n新连接立即失效（服务端按文件变化热读）。已建立的连接不会被踢，重启后彻底消失。');
    } catch (error) {
      fail((error as Error).message);
    }
    break;
  }

  case 'check': {
    const raw = argv[1] ?? '';
    const decoded = decodePairing(raw);
    if (!decoded.ok) {
      fail(`配对串解析失败：${decoded.reason}`);
    }
    const p = decoded.pairing;
    const problem = classifyToken(p.token);
    console.log(`host   ${p.host}`);
    console.log(`port   ${p.port}`);
    console.log(`tls    ${p.tls ? '是' : '否'}`);
    console.log(`device ${p.deviceId ?? '(未绑定)'}`);
    console.log(`token  ${maskToken(p.token)}  ${problem === null ? '（合格）' : `（不合格）${describeTokenProblem(p.token, problem)}`}`);
    const safety = checkBindSafety({ host: p.host, hasTls: p.tls, hasAuth: true });
    if (!safety.ok) {
      console.log(`\n⚠ 这个监听地址目前绑不上：\n${safety.message}`);
    }
    if (problem !== null) {
      process.exit(2);
    }
    break;
  }

  default:
    console.error('用法:');
    console.error('  node src/pair.ts new    [--device <id>] [--host <addr>] [--port <n>] [--tls] [--file <path>]');
    console.error('  node src/pair.ts list   [--file <path>]');
    console.error('  node src/pair.ts revoke --device <id> | --token <token> [--file <path>]');
    console.error('  node src/pair.ts check  <配对串>');
    console.error('\n文件默认取环境变量 MIAI_TOKENS，没有就是 ./tokens.txt');
    process.exit(1);
}
