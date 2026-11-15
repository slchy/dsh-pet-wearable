#!/bin/bash
# 测裸 DeepSeek API 的速度：TTFT + 输出 token/s。
# 目的：判断 65–103 token/s 是模型本身，还是 dsh 层的开销。
set -a
. <部署路径>/miai-cloud/.env
set +a

KEY="${DEEPSEEK_API_KEY:-${DEEPSEEK_KEY:-${DSH_DEEPSEEK_API_KEY:-}}}"
if [ -z "$KEY" ]; then
  echo "找不到 DeepSeek API key（试过 DEEPSEEK_API_KEY / DEEPSEEK_KEY / DSH_DEEPSEEK_API_KEY）"
  cut -d= -f1 <部署路径>/miai-cloud/.env | grep -i -e deepseek | head -10
  exit 1
fi

node - "$KEY" <<'NODE'
const key = process.argv[2];
const question = '用大约两百字介绍一下杭州这个城市';
const t0 = Date.now();
let ttft = 0;
let text = '';
let usage = null;

const res = await fetch('https://api.deepseek.com/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: question }],
    stream: true,
    stream_options: { include_usage: true },
  }),
});

if (!res.ok) {
  console.log('HTTP', res.status, (await res.text()).slice(0, 300));
  process.exit(1);
}

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') continue;
    let j;
    try { j = JSON.parse(data); } catch { continue; }
    const delta = j.choices?.[0]?.delta?.content;
    if (delta) {
      if (ttft === 0) ttft = Date.now() - t0;
      text += delta;
    }
    if (j.usage) usage = j.usage;
  }
}
const total = Date.now() - t0;
const outTok = usage?.completion_tokens ?? '?';
console.log(`TTFT        ${ttft} ms`);
console.log(`总耗时      ${total} ms`);
console.log(`输出字数    ${[...text].length}`);
console.log(`输出 token  ${outTok}`);
if (typeof outTok === 'number' && total > ttft) {
  console.log(`生成速度    ${(outTok / ((total - ttft) / 1000)).toFixed(1)} token/s（按 TTFT 之后算）`);
  console.log(`整体速度    ${(outTok / (total / 1000)).toFixed(1)} token/s`);
}
NODE
