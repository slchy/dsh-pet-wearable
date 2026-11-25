/**
 * headless 的 NDJSON：取出会话 id、最终文本、流式兜底和收尾 usage。
 */
import type { TokenUsage } from './usage.ts';

/** 从 NDJSON 事件流里取会话 id、最终文本、usage 与流式文本。 */
export function parseEvents(stdout: string): {
  sessionId: string | null;
  final: string | null;
  streamed: string;
  usage: TokenUsage | null;
} {
  let sessionId: string | null = null;
  let final: string | null = null;
  let streamed = '';
  let usage: TokenUsage | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(s) as Record<string, unknown>;
    } catch {
      continue; // 半行/非 JSON，跳过
    }
    const type = event['type'];
    if (type === 'session') {
      const id = event['sessionId'];
      if (typeof id === 'string' && id) sessionId = id;
    } else if (type === 'final') {
      const text = event['text'];
      if (typeof text === 'string') final = text;
    } else if (type === 'text') {
      // --json 模式下 text 是流式增量；final 缺失时用它兜底
      const text = event['text'];
      if (typeof text === 'string') streamed += text;
    } else if (type === 'status') {
      const raw = event['usage'];
      if (raw && typeof raw === 'object') {
        const parsed = raw as TokenUsage;
        // 收尾那一次的输入就是上下文规模；同样要含缓存命中部分
        usage = {
          ...parsed,
          contextTokens: (parsed.inputTokens ?? 0) + (parsed.cacheReadTokens ?? 0),
        };
      }
    }
  }

  return { sessionId, final, streamed, usage };
}
