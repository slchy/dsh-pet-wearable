/**
 * 给 dsh 的 SDK 运行时补上 `session/cancel`。
 *
 * 底座的取消能力一直是现成的（`agent.cancel({kind:'user'},{keepInbox:true})`），
 * 只是 `dsh-sdk-jsonrpc-server` 的 `handleRequest` 是个硬编码 switch，没把它放进来。
 * 上游也没打算放：最新的 `@deepseek-ai/dsh-sdk-jsonrpc-server@0.0.1-rc.5` 里
 * `cancel` 出现 0 次。所以只能在落地的这份文件上补 6 行。
 *
 * **升级 dsh 之后要重跑一次**（`npm i -g @deepseek-ai/dsh` 会把文件覆盖回去）。
 * 靠 `--check` 一眼看出还在不在：harness 启动时也会打一行「取消能力」探针。
 *
 * 补丁丢了不会坏事，只会退化成「取消不了」：客户端收到 `-32603` 记一行日志，
 * 2000 ms 兜底唤醒在途那一轮（见 `src/session.ts` 的 `cancelTurn`）。
 *
 *   node scripts/patch-sdk-cancel.mjs          # 打补丁（幂等）
 *   node scripts/patch-sdk-cancel.mjs --check   # 只看在不在，退出码 0=在 3=不在
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const REL = 'node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js';
const ANCHOR = '\t\t\tcase "shutdown": return this.shutdown();';

/** 补丁体：参数校验 → 查会话 → 调 agent.cancel。只多一个 case，别的一行不动。 */
const PATCH = `\t\t\tcase "session/cancel": {
\t\t\t\tconst sessionId = params?.sessionId;
\t\t\t\tif (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("session/cancel requires a non-empty sessionId string");
\t\t\t\tconst rec = this.sessions.get(sessionId);
\t\t\t\tif (rec === undefined) return { accepted: false };
\t\t\t\tthis.assertLiveAgent(rec, sessionId);
\t\t\t\trec.handle.agent.cancel({ kind: "user" }, { keepInbox: true });
\t\t\t\treturn { accepted: true };
\t\t\t}
`;

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const explicit = args.find((a) => !a.startsWith('--'));

function candidates() {
  if (explicit) {
    return [explicit];
  }
  const roots = [];
  try {
    roots.push(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    // npm 不在 PATH 上就走下面的猜测
  }
  roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules');
  if (process.env['APPDATA']) {
    roots.push(join(process.env['APPDATA'], 'npm', 'node_modules'));
  }
  return roots.filter(Boolean).map((root) => join(root, '@deepseek-ai', 'dsh', REL));
}

const target = candidates().find((p) => existsSync(p));
if (target === undefined) {
  console.error('找不到 dsh-sdk-jsonrpc-server 的 lib/index.js，可用参数直接指定路径');
  process.exit(1);
}

const src = readFileSync(target, 'utf8');
const patched = src.includes('session/cancel');

if (checkOnly) {
  console.log(patched ? `取消能力：在（${target}）` : `取消能力：不在（${target}）`);
  process.exit(patched ? 0 : 3);
}

if (patched) {
  console.log(`已经打过补丁，不动：${target}`);
  process.exit(0);
}

if (!src.includes(ANCHOR)) {
  console.error(`锚点没找到（dsh 版本变了？）：${ANCHOR}`);
  console.error('先人工确认这份文件里的 switch 结构，再改本脚本的 ANCHOR。');
  process.exit(2);
}

copyFileSync(target, `${target}.orig`);
writeFileSync(target, src.replace(ANCHOR, PATCH + ANCHOR), 'utf8');
console.log(`补丁已打：${target}`);
console.log(`原文件备份在 ${target}.orig（dsh 升级时会被一起覆盖，无所谓）`);
console.log('要让常驻的 dsh 子进程用上，需要重启 miai-harness。');
