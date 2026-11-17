/**
 * 探针：流式模型的 token 节奏 —— 第 8 个、第 20 个 token 各要多久。
 *
 * 用途：`live-text.ts` 的 `LIVE_TOKEN_THRESHOLD = 20` 意味着前 20 个 token 不放给
 * TTS。要知道降低门槛能省多少，先得知道「第 8 个 token 比第 20 个早多久」。
 *
 * 走快车道同一个口（`FAST_LANE_*`，默认就是 qwen-flash / DashScope 兼容口），
 * 因为短答由快车道答，它的节奏才决定 ③。
 *
 * 跑法：node scripts/probe-token-cadence.mts
 */
for (const line of (await import('node:fs')).readFileSync('../../.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m !== null && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const apiKey = (process.env['FAST_LANE_API_KEY'] ?? process.env['DEEPSEEK_API_KEY'] ?? '').trim();
if (apiKey === '') {
  throw new Error('缺 FAST_LANE_API_KEY / DEEPSEEK_API_KEY');
}
const baseUrl = process.env['FAST_LANE_BASE_URL'] ?? 'https://api.deepseek.com';
const model = process.env['FAST_LANE_MODEL'] ?? 'deepseek-chat';

const PROMPT = '用一句话回答：现在几点了？（不超过二十个字）';

async function run(round: number): Promise<void> {
  const started = Date.now();
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: PROMPT }],
      stream: true,
      max_tokens: 64,
    }),
  });
  if (!res.ok || res.body === null) {
    throw new Error(`HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let rest = '';
  let tokens = 0;
  let text = '';
  const marks = new Map<number, number>();
  const marksChar = new Map<number, number>();

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += decoder.decode(value, { stream: true });
    const lines = rest.split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      let json: { choices?: { delta?: { content?: string } }[] };
      try { json = JSON.parse(payload); } catch { continue; }
      const delta = json.choices?.[0]?.delta?.content ?? '';
      if (delta === '') continue;
      tokens += 1;
      text += delta;
      if (!marks.has(tokens)) marks.set(tokens, Date.now() - started);
      const chars = [...text].length;
      if (!marksChar.has(chars)) marksChar.set(chars, Date.now() - started);
    }
  }
  const total = Date.now() - started;
  const at = (n: number, map: Map<number, number>): string => {
    const v = map.get(n);
    return v === undefined ? '   —' : `${String(v).padStart(4)}`;
  };
  console.log(
    `第 ${round} 轮  总 ${String(total).padStart(4)} ms  ${String(tokens).padStart(2)} token / ${[...text].length} 字\n`
    + `        按 token：t2=${at(2, marks)}  t4=${at(4, marks)}  t8=${at(8, marks)}  t12=${at(12, marks)}  t20=${at(20, marks)}  t末=${at(tokens, marks)}\n`
    + `        按字符：c2=${at(2, marksChar)}  c5=${at(5, marksChar)}  c8=${at(8, marksChar)}  c12=${at(12, marksChar)}  c20=${at(20, marksChar)}\n`
    + `        文本：${JSON.stringify(text.slice(0, 40))}`,
  );
}

console.log(`model=${model}  base=${baseUrl}\n`);
for (let i = 1; i <= 6; i += 1) {
  await run(i);
  await new Promise<void>((r) => { setTimeout(r, 400); });
}
process.exit(0);

