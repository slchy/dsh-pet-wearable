import { Agent, setGlobalDispatcher } from 'undici';

/**
 * HTTP 连接的保活时长（ms）。`MIAI_HTTP_KEEPALIVE_MS` 可覆盖。
 *
 * **为什么要它**：Node 的 `fetch`（undici）默认 `keepAliveTimeout` 只有 **4 秒**，
 * 而真机两轮之间常隔 4–16 秒 —— 等于**每一轮都重新做 TCP + TLS 握手**。
 * 2026-11-19 在服务器上量到（同一条到 DashScope 的连接）：
 *
 * | 连接状态 | 响应头 |
 * |---|---|
 * | 复用 | 146–296 ms |
 * | 新建 | 375–434 ms |
 *
 * 差 **130–190 ms**，而且它同时拖慢快车道、对冲两路、投机和 dsh —— 这几条都走 `fetch`。
 *
 * **服务端不会先关**：把客户端超时放到 15 分钟后，空闲 20 / 30 / 45 / 60 秒各测 10 次，
 * 全部复用成功、**0 次失败**（每组第一次是新建，因为连接刚建）。所以 50 秒是安全的。
 *
 * ⚠️ **别把这里设得比服务端的空闲超时长**：复用一条已被对端关掉的连接会直接
 * `ECONNRESET`/`EPIPE`，那比多等 100 ms 糟得多。真要调大，先重跑那个测量。
 * 复用失败的样本会落进 `agent.conn`（见 `fronted-agent.ts`）。
  *
  * **实测（2026-11-19，线上同款 `fetch`）**：装了这个 dispatcher 之后，空闲
  * 5 / 8 / 15 / 30 / 45 秒后的响应头全在 133–258 ms；不装则 5 秒后跳到 436 ms。
 */
export const DEFAULT_KEEPALIVE_MS = 50_000;

/**
 * 把**全局** dispatcher 换成长保活的 `Agent`。
 *
 * 换全局而不是给每个请求传 `dispatcher`：`fetch` 的调用点散布在快车道、dsh 桥、
 * 保活、TTS/STT 里，漏一个就悄悄退回 4 秒；而且 `fetch(url, {dispatcher})` 不在
 * 标准签名里，TS 认不出来。
 *
 * 必须在**任何 `fetch` 之前**调用 —— `main.ts` 在 `loadDotEnv()` 之后立刻调一次。
 */
export function installHttpAgent(keepAliveMs = DEFAULT_KEEPALIVE_MS): Agent {
  const agent = new Agent({
    keepAliveTimeout: keepAliveMs,
    // `keepAliveTimeout` 是**我们自己**的默认值。服务端若回了 `Keep-Alive: timeout=N`，
    // undici 会改用 `min(N*1000, keepAliveMaxTimeout)` —— 也就是说**服务端说了算**，
    // 这个上限只可能把保活压短，**不可能放长**。（2026-11-19 这里原来写反了，
    // 当时的注释声称它能「顶住服务端一句 timeout=4」，实际不能。）
    //
    // 之所以 50 s 仍然生效，是因为实测 DashScope **不带这个提示头**：
    // 空闲 20/30/45/60 秒各 10 次全部复用成功、0 次失败。换个厂商要先重测。
    keepAliveMaxTimeout: keepAliveMs,
    connections: 16,
  });
  setGlobalDispatcher(agent);
  return agent;
}
