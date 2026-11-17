#!/usr/bin/env node
/**
 * 快模型选型的**首字实测**：同一份提示词，逐个供应商/模型量「首 token 到达」。
 *
 *   cd ~/miai-cloud && set -a && . .env && set +a
 *   node bench/fast_lane/probe_models.mjs            # 默认这一批候选
 *   node bench/fast_lane/probe_models.mjs --runs 5
 *
 * 为什么要有它：换快模型时唯一能信的是**同一台机器、同一句提示词**量出来的首字。
 * 各家文档的 TTFT 口径不一样（有的算 reasoning token、有的算网关排队），
 * 而且思考档会把首字拖到秒级 —— 所以这里同时记录 `reasoning_content` 有没有出现。
 *
 * 只依赖 OpenAI 兼容的 `/chat/completions` 流式接口。缺对应 key 的候选自动跳过。
 */

const RUNS = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 3;

/** 与生产一致的提示词形态：一句人设 + 一句闲聊（首字主要取决于模型，不取决于这段话） */
const MESSAGES = [
  {
    role: 'system',
    content: '你是米馍，哥的语音助理。回复不超过二十字，每句开头写一个情绪标签，从'
      + '[开心][得意][惊讶][平静][担心][委屈] 里选。正文不要出现方括号。',
  },
  { role: 'user', content: '你好呀' },
];

/** 候选：`extra` 里放各家「关思考」的参数（不认识就会 400，正好也测出来） */
const CANDIDATES = [
  {
    name: 'deepseek-chat',
    base: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    key: 'DEEPSEEK_API_KEY',
    note: '当前生产默认（非思考档）',
  },
  {
    name: 'deepseek-chat +thinking:off',
    base: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    key: 'DEEPSEEK_API_KEY',
    extra: { thinking: { type: 'disabled' } },
    note: '试探官方是否接受显式关思考',
  },
  {
    name: 'qwen-flash',
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-flash',
    key: 'DASHSCOPE_API_KEY',
  },
  {
    name: 'qwen-turbo',
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-turbo',
    key: 'DASHSCOPE_API_KEY',
  },
  {
    name: 'qwen-plus',
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    key: 'DASHSCOPE_API_KEY',
  },
  {
    name: 'qwen3-flash +enable_thinking:false',
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3-flash',
    key: 'DASHSCOPE_API_KEY',
    extra: { enable_thinking: false },
    note: 'Qwen3 系列默认开思考，必须显式关',
  },
];

async function probe(candidate) {
  const key = (process.env[candidate.key] ?? '').trim();
  if (key === '') {
    return { candidate, skipped: true };
  }
  const samples = [];
  let reasoning = 0;
  let failure = null;
  for (let i = 0; i < RUNS; i += 1) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(new Error('超时 10 s')); }, 10_000);
    try {
      const response = await fetch(`${candidate.base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: candidate.model,
          stream: true,
          temperature: 0.8,
          max_tokens: 64,
          messages: MESSAGES,
          ...(candidate.extra ?? {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) {
        const text = await response.text().catch(() => '');
        failure = `HTTP ${response.status} ${text.slice(0, 160)}`;
        break;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let first = null;
      let sawReasoning = false;
      let done = false;
      while (!done) {
        const { value, done: end } = await reader.read();
        if (end) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) {
            continue;
          }
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') {
            done = true;
            break;
          }
          let chunk;
          try { chunk = JSON.parse(payload); } catch { continue; }
          const delta = chunk.choices?.[0]?.delta ?? {};
          if (delta.reasoning_content) {
            sawReasoning = true;
          }
          if (delta.content && first === null) {
            first = Date.now() - started;
            done = true;
            break;
          }
        }
      }
      if (first === null) {
        failure = '没收到 content（可能全是 reasoning）';
        break;
      }
      samples.push(first);
      if (sawReasoning) {
        reasoning += 1;
      }
    } catch (error) {
      failure = (error instanceof Error ? error.message : String(error));
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  return { candidate, samples, reasoning, failure };
}

function pct(values, q) {
  if (values.length === 0) {
    return '—';
  }
  const sorted = [...values].sort((a, b) => a - b);
  return String(sorted[Math.max(0, Math.min(sorted.length - 1, Math.round((q / 100) * (sorted.length - 1))))]);
}

const results = [];
for (const candidate of CANDIDATES) {
  process.stdout.write(`… ${candidate.name}\r`);
  results.push(await probe(candidate));
}
process.stdout.write(' '.repeat(40) + '\r');

console.log(`每个候选 ${RUNS} 次，同一句提示词，只量「首个 content token」\n`);
console.log('候选'.padEnd(34) + '首字 ms（各次）'.padEnd(30) + 'p50  思考  备注');
for (const r of results) {
  if (r.skipped) {
    console.log(`${r.candidate.name.padEnd(34)}（缺 ${r.candidate.key}）`);
    continue;
  }
  if (r.failure) {
    console.log(`${r.candidate.name.padEnd(34)}✗ ${String(r.failure).slice(0, 60)}`);
    continue;
  }
  console.log(
    `${r.candidate.name.padEnd(34)}${(r.samples.join(' ')).padEnd(30)}`
    + `${pct(r.samples, 50).padStart(4)}  ${r.reasoning > 0 ? '有' : '无'}   ${r.candidate.note ?? ''}`,
  );
}
console.log('\n注：思考=流里出现过 reasoning_content（有就说明首字被推理拖住了）');
