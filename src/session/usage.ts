/**
 * 一轮里的 token 账。成本（累加）和上下文规模（最后一步）分开记。
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
  /**
   * 单次最大输入 = **最后一个 step** 的上下文规模。
   *
   * 一轮里有多个 step（工具调用）时，`inputTokens` 累加起来是"这一轮总共读了
   * 多少 token"（成本口径），而 `contextTokens` 是"当时上下文有多大"（压缩阈值口径）。
   * 监控 12.5 万那条线要看的是后者，累加值永远看不出问题。
   */
  contextTokens?: number;
}

/**
 * 把一个 step 的 usage 折进本轮累计值。
 *
 * 两个口径必须分开：
 * - `inputTokens` / `outputTokens` / `cacheReadTokens` **累加** = 这一轮总共花了多少
 * - `contextTokens` 取**最后一个** step 的输入 = 当时上下文有多大
 *
 * `contextTokens` 必须是 `inputTokens + cacheReadTokens`：DeepSeek 只把**未命中缓存**
 * 的那部分算进 inputTokens，命中的记在 cacheReadTokens 里。真机实测一轮
 * `tokens=144/13 cache=67584`，只取 inputTokens 会得出「上下文 144 token」这种
 * 离谱数字 —— 压缩阈值永远看着没到，实际早就该压了。
 *
 * 混成一个数还会得出两个错误结论之一：要么低估成本，要么永远看不出上下文已经
 * 逼近压缩阈值（累加值一直在涨，反而更像"正常"）。
 */
export function foldStepUsage(acc: TokenUsage | null, step: TokenUsage): TokenUsage {
  const hasContext = step.inputTokens !== undefined || step.cacheReadTokens !== undefined;
  const contextTokens = hasContext
    ? (step.inputTokens ?? 0) + (step.cacheReadTokens ?? 0)
    : acc?.contextTokens;
  return {
    inputTokens: (acc?.inputTokens ?? 0) + (step.inputTokens ?? 0),
    outputTokens: (acc?.outputTokens ?? 0) + (step.outputTokens ?? 0),
    cacheReadTokens: (acc?.cacheReadTokens ?? 0) + (step.cacheReadTokens ?? 0),
    ...(contextTokens === undefined ? {} : { contextTokens }),
  };
}
