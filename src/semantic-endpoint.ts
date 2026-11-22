/**
 * 语义判停：让一个小模型只回答一件事 —— **用户这句话说完了没有**。
 *
 * <h2>为什么声学判停不够</h2>
 *
 * `TurnJudge` 看的是**音频本身**（韵律、停顿、音高），它回答的是「这段听起来像不像
 * 一个句尾」。真机 `20261122-2259` 里用户连续口述，7 次「判停 0.985 静音 ≥ 门槛，
 * 放行」全错 —— 每一处停顿在韵律上都是干净的句尾，语义上却只是半句：
 *
 * ```text
 * 实在不甘心的话，可以趁现在停一下想想。     ← p=0.985，开了一轮
 * 如果你发现自己。对。本地。                  ← 其实是上一句的下文
 * ```
 *
 * 那种信息不在音频里，只在**文字**里。所以这里用标签判：模型只吐 `END` 或 `MORE`，
 * 我们按标签决定「开轮」还是「再等一拍」——比一个概率阈值好调，也落档可查。
 *
 * <h2>约束</h2>
 *
 * - 只判当前这段文字，**不回答内容**（一句话的 prompt，`max_tokens` 极小）。
 * - 超时/失败一律回 `null`，调用方按「说完」处理 —— 宁可多答一轮，不能把话吞了。
 * - 调用发生在定稿之后、开轮之前，与既有的静音窗（`openQuietMs`）重叠，所以
 *   通常**不额外加延迟**；等不到就按 `null` 走。
 */
export interface SemanticEndpointOptions {
  readonly apiKey: string;
  readonly model?: string;
  /** DeepSeek 兼容端点；默认与快车道一致 */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** 单次判定的上限；超时回 `null`（调用方按「说完」处理） */
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
}

export type SemanticVerdict = 'end' | 'more' | null;

export interface SemanticEndpoint {
  /**
   * @param text 当前攒到的整句（不是增量）
   * @returns `'end'` 说完、`'more'` 还有下文、`null` 拿不准/失败
   */
  judge(text: string): Promise<SemanticVerdict>;
}

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen-flash';
const DEFAULT_TIMEOUT_MS = 400;

/**
 * 判停提示词。
 *
 * 两条实测约束（跟工具描述那类坑一样：**位置比措辞重要**）：
 * 1. 规则写在 **system** 里。写进 user 那一栏时模型会顺手回答那句话本身。
 * 2. 例子只给「没说完」的，不给「说完」的 —— 给全了它会开始解释为什么，`max_tokens`
 *    被解释吃掉就没标签了。
 *
 * 第三条是**真机档案换来的**（20261122-232814，4 次延长全白等）：漏掉「问句、祈使句
 * 完整即 END」那一行时，模型把「你重复一遍。」「你在说什么？」「那你给我讲讲…的剧情。」
 * 全判成 MORE —— 它似乎认为「用户提问 = 后面还有话」。用真机原文当测试集比过：
 * 加这一行 12/12 与 11/12，不加 9/12 与 8/12（`tmp/omni-probe/end-tag3.mjs`）。
 */
const SYSTEM_PROMPT = [
  '你只做一件事：判断用户这句话**说完了没有**。不要回答问题本身，不要解释。',
  '说完了 → 只输出 END',
  '问句、祈使句只要本身完整就是 END —— 用户问完/交代完了，剩下的不关你的事。',
  '只有明显断在半句（缺谓语、以「如果」「因为」「我觉得」「你讲一下…的」这类收尾）才输出 MORE',
  '拿不准 → 输出 END（宁可让它先说，也别把用户晾着）',
].join('\n');

export function semanticEndpoint(options: SemanticEndpointOptions): SemanticEndpoint {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((): void => {});
  const url = `${baseUrl}/chat/completions`;

  return {
    async judge(text: string): Promise<SemanticVerdict> {
      const trimmed = text.trim();
      if (trimmed === '') {
        return 'end';
      }
      const controller = new AbortController();
      const startedAt = Date.now();
      // `abort()` 只是**请求**取消：真 fetch 会 reject，但自定义/代理实现可能一声
      // 不响地挂住。判停绝不能挂住开轮，所以再叠一个硬 race，两个定时器一起清。
      let abortTimer: ReturnType<typeof setTimeout> | null = null;
      let hardTimer: ReturnType<typeof setTimeout> | null = null;
      const hardTimeout = new Promise<never>((_resolve, reject) => {
        hardTimer = setTimeout(() => {
          const error = new Error(`语义判停超时（${timeoutMs} ms）`);
          error.name = 'AbortError';
          reject(error);
        }, timeoutMs + 50);
      });
      abortTimer = setTimeout(() => { controller.abort(); }, timeoutMs);
      try {
        const response = await Promise.race([
          fetchImpl(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${options.apiKey}`,
            },
            body: JSON.stringify({
              model,
              max_tokens: 4,
              temperature: 0,
              messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: trimmed },
              ],
            }),
            signal: controller.signal,
          }),
          hardTimeout,
        ]);
        if (!response.ok) {
          log(`  判停    ✗ 语义判停 HTTP ${response.status}`);
          return null;
        }
        const body = await response.json() as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const raw = (body.choices?.[0]?.message?.content ?? '').trim().toUpperCase();
        const verdict: SemanticVerdict = raw.includes('MORE')
          ? 'more'
          : raw.includes('END')
            ? 'end'
            : null;
        log(
          `  判停    ${JSON.stringify(trimmed.slice(0, 24))} 语义=${verdict ?? '拿不准'}`
          + `（${Date.now() - startedAt} ms）`,
        );
        return verdict;
      } catch (error) {
        // 超时按「拿不准」走：不能因为判停这一层把用户的话吞掉
        const name = (error as Error).name;
        log(
          `  判停    ✗ 语义判停`
          + (name === 'AbortError'
            ? `超时（${timeoutMs} ms）`
            : `失败：${(error as Error).message}`),
        );
        return null;      } finally {
        if (abortTimer !== null) {
          clearTimeout(abortTimer);
        }
        if (hardTimer !== null) {
          clearTimeout(hardTimer);
        }
      }
    },
  };
}
