/**
 * 探针：连 dsh 的 sdk profile，把**所有** JSON-RPC 通知原样打出来。
 *
 * 目的只有一个：确认流式助手文本到底有没有被推给客户端
 * （若只有 assistant/message，那"边生成边播"就没法做）。
 */
import { spawn } from 'node:child_process';

const patch = process.argv[2];
const answer = process.argv[3] ?? '用一句话说说今天适合做什么';
const extraPatches = process.argv.slice(4);

const proc = spawn(
  'dsh',
  ['--profile', 'sdk', '--patch', patch, ...extraPatches.flatMap((p) => ['--patch', p])],
  { stdio: ['pipe', 'pipe', 'inherit'] },
);

const seen = new Map();
let buf = '';
let promptAt = 0;
let firstAssistantAt = 0;
proc.stdout.setEncoding('utf8');
proc.stdout.on('data', (d) => {
  buf += d;
  let nl = buf.indexOf('\n');
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\n');
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (typeof m.method === 'string') {
      const key = m.method.startsWith('session.event')
        ? `session.event:${m.params?.event?.type ?? '?'}`
        : m.method;
      if (key === 'session.event:assistant/message' && firstAssistantAt === 0) {
        firstAssistantAt = Date.now();
        console.log(`>>> 首条 assistant/message：距 prompt ${firstAssistantAt - promptAt} ms`);
      }
      seen.set(key, (seen.get(key) ?? 0) + 1);
      const n = seen.get(key);
      if (n <= 3) {
        console.log('[notify]', key, JSON.stringify(m.params).slice(0, 260));
      }
    } else if (m.id !== undefined) {
      console.log('[resp]', m.id, JSON.stringify(m.result ?? m.error).slice(0, 160));
    }
  }
});

const send = (obj) => proc.stdin.write(`${JSON.stringify(obj)}\n`);

const sessionId = `probe-${Date.now()}`;
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    cwd: process.env.DSH_WORKSPACE ?? process.cwd(),
    provider: process.env.DSH_PROVIDER ?? 'deepseek-official',
    model: process.env.DSH_MODEL ?? 'deepseek-flash',
  },
});

setTimeout(() => {
  console.log('--- prompt ---');
  promptAt = Date.now();
  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/prompt',
    params: { sessionId, contentBlocks: [{ type: 'text', text: answer }] },
  });
}, 12_000);

setTimeout(() => {
  console.log('--- 事件统计 ---');
  for (const [k, v] of [...seen].sort((a, b) => b[1] - a[1])) {
    console.log(String(v).padStart(4), k);
  }
  try { proc.kill(); } catch { /* 已退 */ }
  process.exit(0);
}, 45_000);
