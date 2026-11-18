/**
 * 给 dsh 的 SDK 运行时补上 `session/fork`。
 *
 * 为什么要它：双向投机里快车道赢了、但 dsh 那一轮**已经答完**（0.6–0.9 s），
 * 它就永久留在 dsh 的会话历史里 —— 用户听到的却是 qwen 的答案。dsh 的会话日志
 * 是 append-only，没有任何「回退事件」（见 `dsh-session/known-event-types.js`
 * 的全量词表），唯一能让历史变短的公开原语就是 `session/fork`：从某个 seq
 * **切一段前缀**长出一个新会话。把它藏起来（换 id、指针跟随），对上层就是
 * 「单会话内撤回上一轮」。
 *
 * 语义（照抄 `dsh-api-session-controller` 的 `SessionCommandController.fork`）：
 * `atSeq` 是**包含式**切割点；省略则取最近一个完整轮次前缀。切在开口处时会补
 * synthetic fork closers（tool 结果 / step / turn 的收尾）。
 *
 * 为什么不是直接挂 `dsh-api-session-controller` 插件：那个包依赖 workspace、
 * preset、gateway 一整套服务，`--profile sdk` 里没挂，挂上去大概率起不来。
 * 这里只复刻它 fork 那 20 行的核心。
 *
 * **升级 dsh 之后要重跑一次**（`npm i -g @deepseek-ai/dsh` 会把文件覆盖回去）。
 *
 *   node scripts/patch-sdk-fork.mjs           # 打补丁（幂等）
 *   node scripts/patch-sdk-fork.mjs --check    # 只看在不在，退出码 0=在 3=不在
 */
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REL = join('node_modules', '@deepseek-ai', 'dsh-sdk-jsonrpc-server', 'lib', 'index.js');
const ANCHOR = '\t\t\tcase "shutdown": return this.shutdown();';
const MARK = 'session/fork';

/** 补丁体：只多一个 case。切点用显式 `atSeq`（客户端算好），不猜。 */
const PATCH = `\t\t\tcase "session/fork": {
\t\t\t\tconst forkSource = params?.sessionId;
\t\t\t\tif (typeof forkSource !== "string" || forkSource.length === 0) throw new TypeError("session/fork requires a non-empty sessionId string");
\t\t\t\tconst forkAt = params?.atSeq;
\t\t\t\tif (forkAt !== undefined && !(Number.isSafeInteger(forkAt) && forkAt >= 0)) throw new TypeError("session/fork atSeq must be a non-negative safe integer");
\t\t\t\tconst forkQuery = this.ctx.get("sessionQuery");
\t\t\t\tif (forkQuery === undefined) throw new Error("session/fork unavailable: sessionQuery service is not mounted");
\t\t\t\tconst forkObserved = await forkQuery.observeSession(forkSource);
\t\t\t\tconst forkEvents = forkObserved.events;
\t\t\t\tconst forkLast = Array.isArray(forkEvents) && forkEvents.length > 0 ? forkEvents[forkEvents.length - 1]?.seq : undefined;
\t\t\t\tconst forkBoundary = forkAt === undefined ? forkLast : forkAt;
\t\t\t\tif (forkBoundary === undefined || forkEvents[forkBoundary]?.seq !== forkBoundary) throw new Error(\`session/fork: event \${String(forkBoundary)} does not exist in session "\${forkSource}" (last seq: \${String(forkLast ?? "none")})\`);
\t\t\t\tconst { buildForkSeed } = await import("@deepseek-ai/dsh-session/fork");
\t\t\t\tconst forkSeed = buildForkSeed(forkEvents, forkBoundary);
\t\t\t\tconst forkChild = \`session-\${globalThis.crypto.randomUUID()}\`;
\t\t\t\tconst forked = await this.ctx.agents.create({
\t\t\t\t\tsessionId: forkChild,
\t\t\t\t\tseed: forkSeed,
\t\t\t\t\tinheritedEventCount: forkBoundary + 1,
\t\t\t\t\tmeta: {
\t\t\t\t\t\t...(forkObserved.header.cwd === undefined ? {} : { cwd: forkObserved.header.cwd }),
\t\t\t\t\t\tparentSession: forkObserved.header.id,
\t\t\t\t\t\tisSeeded: true
\t\t\t\t\t},
\t\t\t\t\tagentOptions: { provider: this.provider, model: this.model }
\t\t\t\t});
\t\t\t\tthis.sessions.set(forkChild, { handle: forked, failure: void 0 });
\t\t\t\treturn { sessionId: forkChild };
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
const patched = src.includes(`case "${MARK}"`);

if (checkOnly) {
  console.log(patched ? `回溯能力：在（${target}）` : `回溯能力：不在（${target}）`);
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

copyFileSync(target, `${target}.fork.orig`);
writeFileSync(target, src.replace(ANCHOR, PATCH + ANCHOR), 'utf8');
console.log(`补丁已打：${target}`);
console.log(`原文件备份在 ${target}.fork.orig（dsh 升级时会被一起覆盖，无所谓）`);
console.log('要让常驻的 dsh 子进程用上，需要重启 miai-harness。');
