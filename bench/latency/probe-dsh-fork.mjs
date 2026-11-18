/**
 * 验 `session/fork` 能不能用：起一个真 dsh（`--profile sdk`），跑两轮，把**第二轮**
 * 从历史里切掉（fork 到它的 `turn/start` 之前），再在新会话上跑一轮，最后检查
 * 新会话的事件里有没有第二轮的痕迹。
 *
 * 前提：`node scripts/patch-sdk-fork.mjs` 已经打过（否则会报 unknown method）。
 *
 *   node bench/latency/probe-dsh-fork.mjs [--keep]
 *
 * 只在服务器上跑（要 dsh 与凭据）。纯读+临时目录，不碰生产档案。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

const KEEP = process.argv.includes('--keep');
const WORK = '/tmp/miai-fork-probe';
const TIMEOUT = 120_000;

mkdirSync(WORK, { recursive: true });

const proc = spawn('dsh', ['--profile', 'sdk'], {
  cwd: WORK,
  env: { ...process.env },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let nextId = 1;
const pending = new Map();
/** 收到的事件，按 seq 记 */
const events = [];
let idleWaiters = [];

proc.stdout.on('data', (chunk) => {
  for (const line of chunk.toString().split('\n')) {
    if (line.trim() === '') continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (typeof msg.id === 'number' && msg.method === undefined) {
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error).slice(0, 300)));
      else p.resolve(msg.result);
      continue;
    }
    if (msg.method === 'session.event' && msg.params?.event) {
      const ev = msg.params.event;
      const data = ev.data ?? {};
      events.push({
        seq: ev.seq,
        type: ev.type,
        sessionId: msg.params.sessionId,
        inserted: Array.isArray(data.inserted) ? data.inserted.length : 0,
        text: (() => {
          try { return data.content[0].text.slice(0, 40); } catch { return ''; }
        })(),
      });
    }
    if (msg.method === 'session.status' && msg.params?.status === 'idle') {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const w of waiters) w();
      continue;
    }
    if (msg.method === 'session.status' && msg.params?.status !== 'idle') {
      // 非 idle 状态无所谓，等 idle
    }
  }
});

const stderr = [];
proc.stderr.on('data', (d) => stderr.push(d.toString()));

function rpc(method, params, timeoutMs = TIMEOUT) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => {
      if (pending.get(id) === undefined) return;
      pending.delete(id);
      reject(new Error(`${method} 超时 ${timeoutMs} ms`));
    }, timeoutMs).unref?.();
  });
}

const waitIdle = () => new Promise((resolve) => { idleWaiters.push(resolve); });

async function turn(sessionId, text) {
  await rpc('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text }] });
  await waitIdle();
}

function log(...args) { console.log(...args); }

try {
  await rpc('initialize', { cwd: WORK, provider: 'deepseek-official', model: 'deepseek-flash' });
  log('✓ initialize');

  const sessionId = `session-probe-${Date.now()}`;
  await turn(sessionId, '哥刚才说：\n（探针）第一句，随便回一个字，别用工具。');
  const seqAfter1 = events.at(-1).seq;
  await turn(sessionId, '哥刚才说：\n（探针）第二句，这句**不该**留在历史里。');
  log(`✓ 两轮跑完，session=${sessionId}，最后 seq=${events.at(-1).seq}`);

  const turnStarts = events.filter((e) => e.type === 'turn/start' && e.sessionId === sessionId);
  if (turnStarts.length < 2) throw new Error(`只看到 ${turnStarts.length} 个 turn/start`);
  // 切点不能取 `turn/start - 1`：那一格是 `agent/inbox/spliced`（把这句话塞进收件箱），
  // 复制过去之后子会话会**把它当成待办重放一遍**（实测过）。要切在入箱之前。
  const secondStart = turnStarts[1].seq;
  const insert = events
    .filter((e) => e.type === 'agent/inbox/spliced' && e.inserted > 0 && e.seq < secondStart)
    .at(-1);
  if (insert === undefined) throw new Error('没找到第二轮的收件箱插入事件');
  const cut = insert.seq - 1;
  log(`  第二轮：入箱 seq=${insert.seq} → 切点 atSeq=${cut}（turn/start 在 ${secondStart}，第一轮结束在 ${seqAfter1}）`);

  const forkStartedAt = Date.now();
  const forked = await rpc('session/fork', { sessionId, atSeq: cut });
  log(`✓ session/fork → ${forked.sessionId}（耗时 ${Date.now() - forkStartedAt} ms）`);

  const before = events.length;
  await turn(forked.sessionId, '哥刚才说：\n（探针）第三句，在新会话里。');
  log(`✓ 新会话跑完一轮，新增事件 ${events.length - before} 条`);

  const childEvents = events.filter((e) => e.sessionId === forked.sessionId);
  log(`  新会话事件里 turn/start 数目：${childEvents.filter((e) => e.type === 'turn/start').length}`);
  const leaked = childEvents.filter((e) => e.type === 'user/message' && e.text.includes('第二句'));
  log(`  幽灵句（第二句）在新会话里出现次数：${leaked.length}${leaked.length === 0 ? ' ✓ 撤回干净' : ' ✗ 没撤干净'}`);
  log(`  子会话 id 已交给调用方：${forked.sessionId}`);
  log(KEEP ? `\n保留下 ${WORK} 与 dsh 会话目录` : '');
  if (!KEEP) rmSync(WORK, { recursive: true, force: true });
  proc.stdin.end();
  process.exit(0);
} catch (error) {
  console.error(`✗ ${error.message}`);
  const err = stderr.join('').trim();
  if (err) console.error(`dsh stderr:\n${err.slice(0, 1200)}`);
  proc.kill('SIGKILL');
  process.exit(1);
}
