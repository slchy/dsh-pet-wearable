/**
 * 快车道的**文本模型客户端**：一封请求的全部机制。
 *
 * 从 `fronted-agent.ts` 拆出来的原因只有一个：那个类同时管路由、历史、账本、
 * 两条车道，再塞进「对冲 + 两段超时 + SSE 判暗号 + 连接错误归因」就没人看得完了。
 * 这里只回答一件事 —— **把一句话问出去、把答案逐字流回来**，其余一概不知道。
 *
 * <h2>不变的三条机制</h2>
 *
 * 1. **对冲**：同一句并发发 N 份，谁先把响应头拿回来谁赢，其余立刻 abort。
 *    为什么按响应头判：实测「响应头 → 首 token」只差 ~1 ms，方差全在等响应头
 *    那一段（130–430 ms，见 `FAST_LANE_TRACE`），抢响应头就等于抢首字。
 *    落败的请求在拿到响应头前就被掐掉，基本不产生生成费用。
 * 2. **两段超时**：首字之前卡住 = 模型不干活，早点让给 dsh；首字之后还在出字 =
 *    正常，给足时间 —— 用一个固定总超时会把「五百多毫秒才说完」的正常答案一起掐掉
 *    （实测 10 条闲聊里 6 条被掐）。
 * 3. **流式判暗号**：见 {@link readStream}。过了判定就逐字推给 TTS，不等整句。
 */
import { EVENTS } from './events.ts';

/** 快模型说「这个我答不了」的唯一暗号 */
export const DELEGATE = '[[DELEGATE]]';

/** 一次快车道请求的结果。 */
export interface FastAnswer {
  readonly text: string;
  readonly firstTokenMs: number;
  readonly delegated: boolean;
  /** 有没有已经推给 TTS（推过就不能再退回 dsh，否则重播） */
  readonly opened: boolean;
}

/** 读流时的两个出口：首字到了（重挂超时）、可以下行了。 */
export interface StreamHooks {
  readonly onFirstToken: () => void;
  readonly emit: (text: string) => void;
}

/**
 * 读 SSE 流：判定暗号、按需早退、过了判定就逐字推给 TTS。
 *
 * 判定只需要看开头两个字符：情绪标签是单 `[`（`[开心]`），暗号是 `[[`，不会误伤。
 * 模型偶尔会先写标签再写暗号（`[平静][[DELEGATE]]`）—— 标签一出现闸门就开，
 * 暗号会被当正文念出去，所以去掉开头的标签再看一眼。
 */
export async function readStream(
  body: ReadableStream<Uint8Array>,
  startedAt: number,
  now: () => number,
  hooks: StreamHooks,
  allowDelegate = true,
): Promise<FastAnswer> {
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  /** 开闸之前攒着的那点字（要看够两个字符才敢判断是不是暗号） */
  let held = '';
  let opened = false;
  let firstTokenMs = 0;

  const finish = (delegated: boolean): FastAnswer => ({ text, firstTokenMs, delegated, opened });

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let at = buffer.indexOf('\n');
    while (at >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf('\n');
      if (!line.startsWith('data:')) {
        continue;
      }
      const payload = line.slice('data:'.length).trim();
      if (payload === '[DONE]') {
        return finish(allowDelegate && text.trim().startsWith(DELEGATE));
      }
      let parsed: { choices?: Array<{ delta?: { content?: string } }> };
      try {
        parsed = JSON.parse(payload) as typeof parsed;
      } catch {
        continue;
      }
      const piece = parsed.choices?.[0]?.delta?.content;
      if (typeof piece !== 'string' || piece === '') {
        continue;
      }
      if (firstTokenMs === 0) {
        firstTokenMs = now() - startedAt;
        hooks.onFirstToken();
      }
      text += piece;
      if (opened) {
        hooks.emit(piece);
        continue;
      }
      held += piece;
      const head = held.trimStart();
      if (allowDelegate && head.startsWith('[[')) {
        return finish(true);
      }
      // 模型偶尔会先写情绪标签再写暗号（`[平静][[DELEGATE]]`）—— 标签一出现闸门就开，
      // 暗号会被当正文念出去。去掉开头的标签再看一眼。
      const withoutTag = head.replace(/^\[[^[\]]{1,4}\]\s*/, '');
      if (withoutTag !== head) {
        if (allowDelegate && withoutTag.startsWith('[[')) {
          return finish(true);
        }
        if (withoutTag === '') {
          continue; // 只有标签，还不知道后面是什么，再等一个字
        }
        opened = true;
        hooks.emit(held);
        held = '';
        continue;
      }
      // 单个 `[` 还没闭合时看不出是标签还是暗号，再等几个字
      if (head.startsWith('[') && !head.includes(']') && head.length < 6) {
        continue;
      }
      opened = true;
      hooks.emit(held);
      held = '';
    }
  }
  // 流没等到 `[DONE]` 就 EOF（代理截断 / 服务端提前关）：判据必须和正常出口一致，
  // 否则 `allowDelegate=false` 的纯聊天模式会被 EOF 静默翻成「委派」。
  return finish(allowDelegate && text.trim().startsWith(DELEGATE));
}

/** 发出去的一条消息（OpenAI 兼容格式）。 */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface AskRequest {
  /** 这一轮用户说了什么（只进审计，不参与拼装） */
  readonly userText: string;
  /** 计时起点。`firstTokenMs` 与日志里的「响应头多少 ms」都相对它 */
  readonly startedAt: number;
  /** 逐字下行的出口（预跑时是槽位缓冲，正常轮是 TTS） */
  readonly emit: (text: string) => void;
  readonly kind: 'prefetch' | 'spec' | 'live';
  /** 已经拼好的 system + 历史窗 + 当前这句 */
  readonly messages: readonly ChatMessage[];
}

export interface FastLlmOptions {
  /** 空串 = 车道的 key 没配。**这里不判**，判不判由路由决定（它知道还有没有别的车道） */
  readonly apiKey?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  /** 首字超时（默认 1200 ms）。见文件头的「两段超时」 */
  readonly timeoutMs?: number;
  /** 首字到了之后，整句最多再等这么久（默认 2800 ms） */
  readonly totalMs?: number;
  /** 对冲份数（默认 1 = 不对冲） */
  readonly hedge?: number;
  /** 关掉时模型写出 `[[DELEGATE]]` 也按正文处理（纯聊天模式） */
  readonly delegateEnabled?: boolean;
  /** 测试注入用 */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly audit?: (name: string, data: Record<string, unknown>) => void;
}

/**
 * 快车道的请求端。**没有状态跨轮次**：一次 {@link ask} 只用自己那一组 controller，
 * 唯一留在字段上的是「当前在途的那一组」的取消句柄（插话要用）。
 */
export class FastLlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly totalMs: number;
  private readonly hedge: number;
  private readonly delegateEnabled: boolean;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly audit: (name: string, data: Record<string, unknown>) => void;

  /**
   * 一次快车道请求的取消句柄。**对冲时是一组**：`abort()` 掐掉全部候选。
   *
   * 不能只存「第 0 份」的 controller —— 对冲是谁先拿回响应头谁赢，实测第 1 份赢的
   * 概率约一半（10 轮 5:5）。存第 0 份的话，胜者是第 1 份时插话取消打在已经作废的
   * 那个上，胜者该吐还吐（探针实测又吐了 1921 字节），预跑「作废」同样掐不住。
   */
  private currentAbort: { abort(why: Error): void } | null = null;

  /**
   * 此刻**在途**的快车道 HTTP 请求数（对冲的每一份单独算）。
   *
   * 为什么要有它：首字超时是从**进门**开始计时的，而请求真正发出去之前可能要在一张
   * 共享的连接池里排队（`installHttpAgent` 的 `connections: 16`，快车道/对冲/投机/dsh
   * 全走同一条全局 dispatcher）。排队时间和厂商务时间算在同一段里，于是一条 200 ms
   * 就该回来的请求也能被判成「首字超时」。
   *
   * 只有失败时把当时的在途数记进错误文本，才能区分「我们把自己堵住了」和「厂商慢」。
   * 这个数在失败那一刻正好是**别人**在途的数 —— 本组的已经全部落地了。
   */
  private inFlight = 0;

  constructor(options: FastLlmOptions) {
    this.apiKey = options.apiKey ?? '';
    this.model = options.model ?? 'deepseek-chat';
    this.baseUrl = options.baseUrl ?? 'https://api.deepseek.com';
    this.timeoutMs = options.timeoutMs ?? 1_200;
    this.totalMs = options.totalMs ?? 2_800;
    this.hedge = Math.max(1, options.hedge ?? 1);
    this.delegateEnabled = options.delegateEnabled ?? true;
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.audit = options.audit ?? (() => {});
  }

  /**
   * 当前这一组的取消句柄（`ask()` 在**第一个 await 之前**同步装好）。
   *
   * 预跑要在调用 `ask()` 之后立刻取它存进槽位，所以不能用回调、更不能等到 promise
   * resolve —— 那时请求早跑完了。
   */
  get abortHandle(): { abort(why: Error): void } | null {
    return this.currentAbort;
  }

  /** 掐掉当前在途的那一组（插话 / 预跑作废）。没有在途请求时什么都不做。 */
  abortCurrent(why: Error): void {
    this.currentAbort?.abort(why);
  }

  /**
   * 把这一句问出去。
   *
   * 抛错时错误文本必须能回答「谁的问题」：每一份的结局（`#0 头@412ms` /
   * `#1 ✗aborted@1201ms`）和进门时的在途数都拼进去。
   */
  async ask(request: AskRequest): Promise<FastAnswer> {
    const { userText, startedAt, emit, kind, messages: msgs } = request;
    const doFetch = this.fetchImpl ?? fetch;
    // **对冲**：同一句并发发 N 份，谁先**把响应头拿回来**谁赢，其余立刻 abort。
    const controllers = Array.from({ length: Math.max(1, this.hedge) }, () => new AbortController());
    const abortAll = (why: Error): void => {
      for (const c of controllers) c.abort(why);
    };
    // 取消句柄是**整组**：插话时把还在跑的候选一起掐掉（见 `currentAbort` 的注释）
    const handle = { abort: abortAll };
    this.currentAbort = handle;
    // **两段超时**：首字之前卡住 = 模型不干活，早点让给 dsh；
    // 首字之后还在出字 = 正常，给足时间 —— 用一个固定总超时会把
    // 「五百多毫秒才说完」的正常答案一起掐掉（实测 10 条闲聊里 6 条被掐）。
    let timer: NodeJS.Timeout = setTimeout(() => {
      abortAll(new Error(`首字超时 ${this.timeoutMs} ms`));
    }, this.timeoutMs);
    // 不 unref：`finally` 里一定会 clearTimeout，unref 省不了什么；
    // 反而让「等这个定时器」变成不保活的事件循环 —— Node 22 的 test runner 会判定
    // 「promise 永远悬着」（本地 Node 24 不复现，服务器上整片超时测试全挂）。
    const rearm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        abortAll(new Error(`整句超时 ${this.totalMs} ms`));
      }, this.totalMs);
    };
    const payload = JSON.stringify({
      model: this.model,
      stream: true,
      temperature: 0.8,
      max_tokens: 64,
      messages: msgs,
    });
    // 全量落档：**发出去的那一刻**就记，而不是等到有答案 —— 预跑/投机被作废时，
    // 「问过什么」才是判断模型行为的起点。`msgs` 含 system + 历史窗 + 当前这句。
    this.audit(EVENTS.agentAsk, {
      kind, model: this.model, hedge: controllers.length, text: userText, msgs,
    });
    try {
      // 每一份的结局都要留痕：失败时 `Promise.any` 只给一个笼统的 reject，
      // 「两份都打满 1200 ms」和「一份 429 + 一份被掐」在日志里长得一样，
      // 但前者是厂商/网络、后者是我们自己的问题。结局最后拼进错误文本，
      // 由调用方的 `agent.done { ok:false, err }` 落进档案（不截断）。
      const outcomes: string[] = [];
      // 进门那一刻已经有多少份在跑 —— 这是「池子被我们自己堵住」的直接读数
      const inFlightBefore = this.inFlight;
      const racers = controllers.map((c, index) => {
        this.inFlight += 1;
        return doFetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: payload,
          signal: c.signal,
        }).then(
          (r) => {
            this.inFlight -= 1;
            const emptyBody = r.ok && r.body === null;
            outcomes[index] = `#${index} 头@${(this.now() - startedAt).toFixed(0)}ms`
              + (r.ok ? '' : ` HTTP ${r.status}`)
              + (emptyBody ? '（空响应体）' : '');
            if (!r.ok || r.body === null) {
              throw new Error(`HTTP ${r.status}${emptyBody ? '（空响应体）' : ''}`);
            }
            return { r, c };
          },
          (e) => {
            this.inFlight -= 1;
            outcomes[index] = `#${index} ✗${(e as Error).name === 'AbortError'
              ? `aborted@${(this.now() - startedAt).toFixed(0)}ms`
              : String((e as Error).message).slice(0, 60)}`;
            throw e;
          },
        );
      });
      // 落败/被打断的那些也要有人接：否则 abort 会变成进程级 rejection（线上挂过）
      for (const p of racers) p.catch(() => undefined);
      let winner: { r: Response; c: AbortController };
      try {
        // `any` 取的是第一个**成功**的（HTTP 错的那份算失败，会自动等另一份）
        winner = await Promise.any(racers);
      } catch {
        throw new Error(
          `HTTP 全部失败（${racers.length} 份）: ${outcomes.join(' | ') || '无结局'}`
          + `（进队前在途 ${inFlightBefore} 份，此刻 ${this.inFlight} 份）`,
        );
      }
      for (const c of controllers) {
        if (c !== winner.c) c.abort(new Error('对冲落败'));
      }
      // 探针（`FAST_LANE_TRACE=1`）：把首字拆成「收发头」与「收头→首 token」。
      // 生产里首字 314–588 而裸探针只要 185–260，差的那截到底是网络、还是我们自己的
      // 事件循环（ffmpeg/TTS/档案都在同一条线程上），只有这个分解能说清。
      if (process.env['FAST_LANE_TRACE'] === '1') {
        const chars = msgs.reduce((n, m) => n + m.content.length, 0);
        this.log(`  快车道    提示词 ${msgs.length} 条 / ${chars} 字`);
        this.log(`  快车道    响应头 ${(this.now() - startedAt).toFixed(0)} ms`
          + `（对冲 ${racers.length} 份，进队前在途 ${inFlightBefore}）`);
      }
      const answer = await readStream(
        winner.r.body!, startedAt, this.now, { onFirstToken: rearm, emit }, this.delegateEnabled,
      );
      // `raw` 是模型原文（可能带 `[平静]` 情绪标签、也可能被 [[DELEGATE]] 早退），
      // `opened` 表示有没有已经推给 TTS —— 两者决定这份答案「能撤回还是已经出口」。
      this.audit(EVENTS.agentDone, {
        kind, ok: true, ms: Math.round(this.now() - startedAt),
        first_token_ms: Math.round(answer.firstTokenMs),
        raw: answer.text, opened: answer.opened, delegated: answer.delegated,
      });
      return answer;
    } catch (error) {
      const message = (error as Error).message;
      this.audit(EVENTS.agentDone, {
        kind, ok: false, ms: Math.round(this.now() - startedAt),
        err: message,
      });
      // **复用一条已被对端关掉的连接**会以这些错误出现，和「模型超时/429」完全不同：
      // 它说明 `MIAI_HTTP_KEEPALIVE_MS` 设得比服务端的空闲超时还长（见 `http-agent.ts`）。
      // 不单列出来，这类失败会被当成普通网络抖动，调那个数就没有依据。
      if (/ECONNRESET|EPIPE|UND_ERR_SOCKET|socket hang up|other side closed/i.test(message)) {
        this.audit(EVENTS.agentConn, { kind, err: message.slice(0, 100) });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      abortAll(new Error('请求结束'));
      // 只清自己那一个：两轮重叠时别把下一轮的那组从记录里抹掉
      if (this.currentAbort === handle) {
        this.currentAbort = null;
      }
    }
  }
}
