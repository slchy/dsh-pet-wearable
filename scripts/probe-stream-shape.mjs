/**
 * 探针 3：长回答时 `assistant/message` 到底推几次、什么时候推。
 *
 * 这是判断「能不能做流式 TTS」的决定性证据：
 * - 若只在最后推 1 条 → SDK 层没有流式，边生成边播做不到；
 * - 若生成过程中推多条（每条带部分文本）→ 可以拿它做增量。
 */
import { spawn } from 'node:child_process';

const patch = process.argv[2];
const question = process.argv[3] ?? '用大约两百字介绍一下杭州这个城市，分几段说。';

const proc = spawn(
  'dsh',
  ['--profile', 'sdk', '--patch', patch],
  { stdio: ['pipe', 'pipe', 'inherit'] },
);

let buf = '';
let promptAt = 0;
let headerAt = 0;
const hits = [];
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
    const type = m.params?.event?.type;
    if (typeof m.method !== 'string' || typeof type !== 'string') continue;
    const at = Date.now() - promptAt;
    if (type === 'request/header') {
      headerAt = Date.now();
      const cfg = m.params?.event?.data?.header?.config ?? {};
      console.log(`[request/header] +${at} ms  model=${cfg.model} effort=${cfg.reasoningEffort}`);
      continue;
    }
    if (type === 'assistant/message') {
      const content = m.params?.event?.data?.message?.content ?? [];
      const reasoning = content
        .filter((c) => c.type === 'reasoning')
        .map((c) => c.text ?? '').join('');
      const text = content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '').join('');
      const usage = m.params?.event?.data?.usage ?? m.params?.event?.data?.message?.usage;
      hits.push({ at, reasoning, text, usage });
      console.log(`[assistant/message] +${at} ms`);
      console.log(`  reasoning ${reasoning.length} 字 / text ${text.length} 字`);
      if (usage) console.log(`  usage ${JSON.stringify(usage).slice(0, 200)}`);
      continue;
    }
    if (type === 'step/start' || type === 'step/end' || type === 'turn/start' || type === 'turn/end') {
      console.log(`[${type}] +${at} ms`);
    }
  }
});

const send = (obj) => proc.stdin.write(`${JSON.stringify(obj)}\n`);
const sessionId = `probe3-${Date.now()}`;

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    cwd: '<部署路径>/voice-workspace',
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
    params: { sessionId, contentBlocks: [{ type: 'text', text: question }] },
  });
}, 12_000);

setTimeout(() => {
  console.log('--- 小结 ---');
  console.log(`assistant/message 共 ${hits.length} 条`);
  for (const h of hits) console.log(`  +${h.at} ms  ${h.kinds}  ${h.textLen} 字`);
  try { proc.kill(); } catch { /* 已退 */ }
  process.exit(0);
}, 75_000);
