/**
 * 阿里云 NLS 实时语音识别（SpeechTranscriber）客户端。
 *
 * 协议要点全部是实测撞出来的，官方示例在
 * `aliyun/alibabacloud-nls-nodejs-sdk/lib/st.js`：
 *
 *   1. `message_id` / `task_id` 必须是 **32 位纯十六进制**（uuid 去掉连字符）
 *   2. `task_id` 由**客户端生成**，StopTranscription 要用同一个
 *   3. StartTranscription 的 header 需要 `name` + `namespace` + `appkey`
 *   4. 顶层必须有 `context`（{ sdk: {...} }），缺了会回误导性的
 *      `Gateway:MESSAGE_INVALID:Missing message name!`
 *   5. token 走 URL query（Node 内置 WebSocket 不支持自定义 header，
 *      实测 query 可用）
 *
 * 判停交给服务端：`SentenceEnd` 就是「这句说完了」，不需要本地 VAD 猜。
 */
import { createHmac, randomUUID } from 'node:crypto';

import type { SttProvider } from './providers.ts';

const SAMPLE_RATE = 16_000;
/** token 提前这么多秒视为过期，避免边界上刚好失效 */
const TOKEN_REFRESH_MARGIN_SEC = 300;

const pct = (s: string): string => encodeURIComponent(s)
  .replace(/\+/g, '%20')
  .replace(/\*/g, '%2A')
  .replace(/%7E/g, '~');

/** NLS 只认 32 位无连字符的十六进制 */
const hex32 = (): string => randomUUID().replace(/-/g, '');

export interface AliyunToken {
  id: string;
  expireAtSec: number;
}

/**
 * token 缓存。**一个进程一份**（由 `aliyunStt` 的闭包持有）。
 *
 * 放在这里的原因：`open()` 每台设备连一次就 new 一个 `AliyunAsr`，缓存若是实例字段，
 * 每台设备的**第一句话**都要付一次 `CreateToken`（实测 334 / 170 / 147 / 134 ms），
 * 而那件事发生在**用户已经开口、VAD 刚激活**的时候 —— 全在关键路径上。
 */
export interface TokenCache {
  token: AliyunToken | null;
}

export interface AliyunAsrOptions {
  akId: string;
  akSecret: string;
  appkey: string;
  /** cn-shanghai / ap-southeast-1 等 */
  region: string;
  /**
   * 换 token 的实现。默认走阿里云 `CreateToken`。
   *
   * 单独抽出来是为了让连接状态机可测：默认实现要在测试里发一次真实
   * HTTPS 请求，那样「旧连接迟到的 close 会不会清掉新连接」这种
   * 纯时序问题就没法写单测。
   */
  tokenProvider?: () => Promise<AliyunToken>;
  /**
   * 进程级 token 缓存。`aliyunStt()` 会传进来一份共享的；
   * 单测/直接构造时可以不给，那就自建一份（只在实例内有效）。
   */
  cache?: TokenCache;
  /** 一句结束后判定「说完了」所需的静音时长（毫秒） */
  maxSentenceSilenceMs?: number;
  /**
   * 业务专属热词表 ID（POP API 创建的那种）。
   *
   * **多数情况不需要配**：控制台配置的「项目热词」与 Appkey 绑定，识别端自动带上，
   * 代码什么都不用做。只有走 POP API 建了独立词表、才需要在这里传 ID。
   *
   * 专有名词靠 LM 先验猜不准时的对症手段：真机实测「审计」在同一轮里错两次、
   * 每次错法都不同，这类词只能靠热词表给声学解码加偏置。词清单见 docs/hotwords.txt。
   */
  vocabularyId?: string;
  /** 中间结果（边说边出字），可选 */
  onPartial?: (text: string) => void;
  /** 一句说完，text 是完整句子 */
  onSentence: (text: string, index: number) => void;
  onError?: (e: Error) => void;
  log?: (line: string) => void;
}

export class AliyunAsrError extends Error {}

/** 用 AK/SK 换临时 token。有效期 24 h，调用方应缓存。 */
export async function createToken(
  akId: string,
  akSecret: string,
  region: string,
): Promise<AliyunToken> {
  const params: Record<string, string> = {
    AccessKeyId: akId,
    Action: 'CreateToken',
    Format: 'JSON',
    RegionId: region,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2019-02-28',
  };
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${pct(k)}=${pct(params[k] ?? '')}`)
    .join('&');
  const stringToSign = `POST&${pct('/')}&${pct(canonical)}`;
  const signature = createHmac('sha1', `${akSecret}&`).update(stringToSign).digest('base64');

  const res = await fetch(`https://nls-meta.${region}.aliyuncs.com/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `${canonical}&Signature=${pct(signature)}`,
  });
  const text = await res.text();
  if (!res.ok) throw new AliyunAsrError(`CreateToken HTTP ${res.status}: ${text.slice(0, 300)}`);

  const json = JSON.parse(text) as { Token?: { Id?: string; ExpireTime?: number } };
  const id = json.Token?.Id;
  const expire = json.Token?.ExpireTime;
  if (!id || !expire) throw new AliyunAsrError(`CreateToken 响应缺字段: ${text.slice(0, 300)}`);
  return { id, expireAtSec: expire };
}

interface TokenCacheInternal {
  token: AliyunToken | null;
}

/**
 * 一条 WebSocket 连接 = 一个持续识别任务。
 *
 * 多轮对话复用同一条连接：服务端会持续发 SentenceBegin/SentenceEnd，
 * 每句独立编号（payload.index）。
 */
export class AliyunAsr {
  private readonly opts: AliyunAsrOptions;
  private ws: WebSocket | null = null;
  private taskId: string | null = null;
  private ready = false;
  private readonly cache: TokenCache;
  private readonly log: (line: string) => void;
  /** 缓冲区：WebSocket 未 ready 时先攒着，别丢音频 */
  private backlog: Buffer[] = [];
  /**
   * true 时丢弃一切输入。
   *
   * 只在 `close()` 置位：表示本条会话已结束，之后即使还有上游音频推来
   * 也不该再进 backlog。**播放期不置位** —— 打断/全双工要求播报期间
   * 上行持续送识别（见 `TODO.md` T-005）。
   */
  private dropping = false;
  /** 每次 `connect()` 加一。token 往返之后代次变了就放弃，不再建连。 */
  private wsGen = 0;
  /**
   * 套接字还在握手时，`close()` 用它解开 `await`。
   * 代次失效的 open/error 回调会直接 return，不解开的话这次建连挂死。
   */
  private settleConnect: (() => void) | null = null;
  /**
   * connect() 正在进行。
   *
   * 必须单独记：connect 要 await token（首次是 1 s 级别的网络请求），
   * 这期间 `ws` 仍是 null。只靠 `!this.ws` 判断的话，每来一个音频 chunk
   * 就发起一次新连接，几十个并发连接互相打架（实测刷出十几次
   * `IDLE_TIMEOUT ... last directive is 'null'`）。
   */
  private connecting = false;

  constructor(opts: AliyunAsrOptions) {
    this.opts = opts;
    this.cache = opts.cache ?? { token: null };
    this.log = opts.log ?? (() => {});
  }

  /**
   * 预取 token（不建 WebSocket）。
   *
   * 由 `aliyunStt.open()` 在**设备连上那一刻**调 —— 用户还没开口，这段网络时间
   * 白拿。不建 WS 是因为空连接会被服务端判 `IDLE_TIMEOUT`（见 `feed()`）：
   * 连接必须在真有音频时才开。
   */
  async warm(): Promise<void> {
    await this.token();
  }

  get isReady(): boolean {
    return this.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  private async token(): Promise<AliyunToken> {
    const now = Math.floor(Date.now() / 1000);
    const cur = this.cache.token;
    if (cur && cur.expireAtSec - now > TOKEN_REFRESH_MARGIN_SEC) return cur;
    const provider = this.opts.tokenProvider
      ?? ((): Promise<AliyunToken> => createToken(this.opts.akId, this.opts.akSecret, this.opts.region));
    const fresh = await provider();
    this.cache.token = fresh;
    return fresh;
  }

  async connect(): Promise<void> {
    if (this.ws || this.connecting) return;
    this.connecting = true;
    const myGen = ++this.wsGen;
    try {
      // 不在 connect 里清 dropping：
      // dropping 只表示「本条会话已结束」，播放期并不置位。
      // 会话结束之后不再恢复。
      this.backlog = [];
      const token = await this.token();
      if (this.dropping || myGen !== this.wsGen) return;
      const url = `wss://nls-gateway-${this.opts.region}.aliyuncs.com/ws/v1`
        + `?token=${encodeURIComponent(token.id)}`;

      const ws = new WebSocket(url);
      if (this.dropping || myGen !== this.wsGen) {
        try { ws.close(); } catch { /* 已断 */ }
        return;
      }
      this.ws = ws;
      this.ready = false;
      this.taskId = null;

      try {
        await new Promise<void>((resolve, reject) => {
          this.settleConnect = resolve;
          const onOpen = (): void => {
            if (this.dropping || myGen !== this.wsGen) return;
            resolve();
          };
          const onError = (e: Event): void => {
            if (this.dropping || myGen !== this.wsGen) return;
            reject(new AliyunAsrError(`WebSocket 连接失败: ${String(e)}`));
          };
          ws.addEventListener('open', onOpen, { once: true });
          ws.addEventListener('error', onError, { once: true });
        });
      } catch (e) {
        // 连不上就把自己摘干净：`feed()` 靠「`this.ws` 为空」判断该不该重连，
        // 留着这条半死的连接会一直往 backlog 里攒音频，永远不再重建。
        this.drop(ws);
        try {
          ws.close();
        } catch {
          // 已断
        }
        throw e;
      } finally {
        this.settleConnect = null;
      }
      if (this.dropping || myGen !== this.wsGen) {
        if (this.ws === ws) this.drop(ws);
        try { ws.close(); } catch { /* 已断 */ }
        return;
      }

      ws.addEventListener('message', (ev) => {
        // 只认**当前**这条连接的消息。旧连接是钩子上没摘干净的孤儿，
        // 它的中间结果会和当前连接打架。
        if (myGen !== this.wsGen || this.dropping || this.ws !== ws) return;
        this.onMessage(ev);
      });
      ws.addEventListener('error', (e) => {
        if (myGen !== this.wsGen || this.dropping || this.ws !== ws) return;
        this.opts.onError?.(new AliyunAsrError(`WebSocket error: ${String(e)}`));
      });
      ws.addEventListener('close', (ev) => {
        if (myGen !== this.wsGen || this.ws !== ws) return;
        this.log(`[asr] 连接关闭 code=${ev.code} reason=${ev.reason || '无'}`);
        // 关键：只有「这条就是当前连接」时才清状态。
        // `hangup()` 会先把 `this.ws` 摘空、500 ms 后才真正 close，这中间
        // 可能已经建了新连接；那时这条迟到的 close 若无条件清 `this.ws`，
        // 新连接就变成没人认领的孤儿（实测同时存活 4 条，结果互相打架）。
        this.drop(ws);
      });

      this.startTranscription();
    } finally {
      this.connecting = false;
    }
  }

  /**
   * 摘掉**指定**这条连接的状态。
   *
   * 不是当前连接就什么都不做 —— 迟到的 close 不能影响后来者。
   */
  private drop(ws: WebSocket | null): boolean {
    if (ws === null || this.ws !== ws) return false;
    this.ws = null;
    this.ready = false;
    this.taskId = null;
    this.backlog = [];
    return true;
  }

  private startTranscription(): void {
    const ws = this.ws;
    if (!ws) return;
    this.taskId = hex32();
    ws.send(JSON.stringify({
      header: {
        appkey: this.opts.appkey,
        message_id: hex32(),
        task_id: this.taskId,
        namespace: 'SpeechTranscriber',
        name: 'StartTranscription',
      },
      payload: {
        format: 'pcm',
        sample_rate: SAMPLE_RATE,
        enable_intermediate_result: true,
        enable_punctuation_prediction: true,
        enable_inverse_text_normalization: true,
        // 服务端判停的静音阈值。默认（800 ms）对话场景偏慢：
        // 说完一句要等近 1 s 才发 SentenceEnd。范围 200–2000。
        ...(this.opts.maxSentenceSilenceMs
          ? { max_sentence_silence: this.opts.maxSentenceSilenceMs }
          : {}),
        // 业务专属热词表：只在配置了真 ID 时下发。
        // 控制台的项目热词与 appkey 绑定、自动生效，不需要走这里。
        ...(this.opts.vocabularyId ? { vocabulary_id: this.opts.vocabularyId } : {}),
      },
      // 缺 context 会被回误导性的 "Missing message name!"
      context: { sdk: { name: 'nls-nodejs-sdk', version: '0.0.1', language: 'nodejs' } },
    }));
  }

  /** 推音频。16 kHz / 单声道 / PCM16 小端。未 ready 时先缓存。 */
  feed(pcm: Buffer, _voiced?: boolean): void {
    if (this.dropping) return;
    // 已经关掉、但 close 事件还没派发的连接不算「还连着」
    if (this.ws && this.ws.readyState === WebSocket.CLOSED) this.drop(this.ws);
    // 懒连接：只有真有待推音频时才建连。
    // 空连接会被服务端判 IDLE_TIMEOUT（实测 `Gateway:IDLE_TIMEOUT`）。
    if (!this.ws && !this.connecting) {
      void this.connect().catch((e: Error) => {
        this.opts.onError?.(e);
      });
    }
    if (!this.isReady) {
      this.backlog.push(pcm);
      // 别无限攒：正常情况下 ready 只要几百毫秒
      if (this.backlog.length > 200) this.backlog.shift();
      return;
    }
    this.send(pcm);
  }

  private send(pcm: Buffer): void {
    try {
      this.ws?.send(pcm);
    } catch (e) {
      this.log(`[asr] 发送失败: ${(e as Error).message}`);
    }
  }

  close(): void {
    this.dropping = true;
    this.wsGen += 1;
    this.abandonConnectAttempt();
    this.hangup();
  }

  /** 解开还挂在套接字握手上的那次 await。 */
  private abandonConnectAttempt(): void {
    const settle = this.settleConnect;
    this.settleConnect = null;
    settle?.();
  }

  /**
   * 挂断连接，但**不改 dropping**。
   *
   * 用于「上行持续静音，主动断开避免被网关判 IDLE_TIMEOUT」——
   * 那种场景后续还要正常收音，不能把 dropping 置上。
   */
  hangup(): void {
    const ws = this.ws;
    if (!ws) return;
    this.backlog = [];
    if (ws.readyState === WebSocket.OPEN && this.taskId) {
      try {
        ws.send(JSON.stringify({
          header: {
            appkey: this.opts.appkey,
            message_id: hex32(),
            task_id: this.taskId,
            namespace: 'SpeechTranscriber',
            name: 'StopTranscription',
          },
          payload: {},
          context: { sdk: { name: 'nls-nodejs-sdk', version: '0.0.1', language: 'nodejs' } },
        }));
      } catch {
        // 已断
      }
    }
    setTimeout(() => {
      try {
        ws.close();
      } catch {
        // 已断
      }
    }, 500).unref?.();
    // 立刻摘空：这 500 ms 里若有音频进来会建新连接，
    // 老连接的 close 靠 `drop()` 的身份判定自动忽略。
    this.drop(ws);
  }

  private onMessage(ev: MessageEvent): void {
    const raw = typeof ev.data === 'string' ? ev.data : '';
    if (!raw) return;
    let msg: {
      header?: { name?: string; status?: number; status_text?: string };
      payload?: { result?: string; index?: number };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const name = msg.header?.name;

    if (name === 'TranscriptionStarted') {
      // 先按到达顺序把积压推完，再对外宣布就绪。
      // 倒过来的话，下一次 `feed()` 会先发新块、再补旧块，音频乱序。
      const queued = this.backlog.splice(0);
      for (const chunk of queued) this.send(chunk);
      this.ready = true;
      this.log(`[asr] 已就绪 task=${this.taskId?.slice(0, 8)}…`);
      return;
    }
    if (name === 'TranscriptionResultChanged') {
      const t = msg.payload?.result;
      if (typeof t === 'string' && t) this.opts.onPartial?.(t);
      return;
    }
    if (name === 'SentenceEnd') {
      const t = msg.payload?.result;
      const idx = msg.payload?.index ?? 0;
      // **不传 `commitSeq`**：NLS 由服务端 VAD 判句，客户端根本没有「第几发 commit」
      // 这个概念。留 `undefined` 是有意义的（见 `causal.ts`）：宿主一律判「不是旧段」，
      // 宁可让一次插话通过，也不能凭空吞掉一轮回答。别在这里硬编一个序号。
      if (typeof t === 'string' && t.trim()) this.opts.onSentence(t.trim(), idx);
      return;
    }
    if (name === 'TranscriptionCompleted') {
      this.log('[asr] 识别任务已结束');
      this.endTask();
      return;
    }
    if (name === 'TaskFailed') {
      const st = msg.header?.status_text ?? `status=${msg.header?.status}`;
      this.opts.onError?.(new AliyunAsrError(`TaskFailed: ${st}`));
      this.endTask();
      return;
    }
  }

  /**
   * 任务结束 → 关掉这条连接。
   *
   * 只置 `ready = false` 是不够的：`feed()` 看到 `this.ws` 还在就以为
   * 「连接好着，只是还没就绪」，于是把音频全攒进 backlog（上限 200 块，
   * 满了就丢）。**用户说什么都不会再被识别**，直到上行静音触发
   * `hangup()` 才恢复 —— 表现为"跑一阵子就听不见了"。
   */
  private endTask(): void {
    const ws = this.ws;
    if (ws === null) return;
    this.drop(ws);
    try {
      ws.close();
    } catch {
      // 已断
    }
  }
}

/**
 * 把阿里云 NLS 包成 {@link SttProvider}，供编排层注入。
 *
 * 凭据从这里进来（部署方负责，别写进源码）；换厂商时只需要另一个同接口的
 * 工厂，编排层不动。
 */
export function aliyunStt(
  creds: Omit<AliyunAsrOptions, 'onSentence' | 'onPartial' | 'onError' | 'log'>,
  log?: (line: string) => void,
): SttProvider {
  // **进程级** token 缓存：token 24 h 有效，一台设备一句就重换一次纯属浪费，
  // 而且那一发恰好落在「用户已经开口」的时刻（实测 334 / 170 / 147 / 134 ms）。
  const cache: TokenCache = { token: null };
  return {
    name: `aliyun:${creds.region}`,
    open: (handlers) => {
      const asr = new AliyunAsr({
        ...creds,
        cache,
        onSentence: handlers.onSentence,
        onPartial: handlers.onPartial,
        onError: handlers.onError,
        log,
      });
      // 设备刚连上、用户还没开口：先把 token 取回来。
      // 失败什么都不影响 —— `feed()` 建连时会再取一次，退化成原来的懒加载。
      void asr.warm().catch((e: Error) => { log?.(`[asr] 预取 token 失败: ${e.message}`); });
      return {
        feed: (pcm) => { asr.feed(pcm); },
        hangup: () => { asr.hangup(); },
        close: () => { asr.close(); },
      };
    },
  };
}
