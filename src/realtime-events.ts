/**
 * DashScope realtime 协议的**唯一事件类型**（纯类型，零运行代码）。
 *
 * 以前 `omni/types.ts`、`omni-tts.ts`、`qwen-realtime-asr.ts` 各写一份
 * 「所有字段都可选」的 `ServerEvent`：消费端 `switch (ev.type)` 之后拿到的还是
 * 同一个宽对象，字段写错不会报错，只会在线上静默变成 `undefined`。
 *
 * 这里收敛成**判别联合**：`type` 是字面量，每个变体只带该事件真正拥有的字段。
 * 服务端将来新增的事件不在联合里，运行时仍然走各消费端的 `default:` 忽略掉；
 * 类型层若要在测试里伪造未知事件，显式写成 `as unknown as ServerEvent`，
 * 不许把 `type` 放宽成 `string` 把整张网拆掉。
 */

/** 服务端 `error` 事件的载荷（字段都以实测回执为准，别照文档补） */
export interface RealtimeErrorDetail {
  readonly code?: string;
  readonly message?: string;
  readonly type?: string;
}

/** `conversation.item.created` / `response.output_item.added` 里的 item 形状 */
export interface RealtimeItemRef {
  readonly id?: string;
  readonly role?: string;
  readonly type?: string;
  readonly call_id?: string;
}

/** `response.done.response.output` 里的一项 */
export interface RealtimeResponseOutputItem {
  readonly id?: string;
  readonly role?: string;
  readonly status?: string;
  readonly type?: string;
  readonly call_id?: string;
}

/** `response.done.response.usage`（记账用；缺字段按缺仪表处理，不补 0） */
export interface RealtimeResponseUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly input_tokens_details?: {
    readonly audio_tokens?: number;
    readonly text_tokens?: number;
  };
  readonly output_tokens_details?: {
    readonly audio_tokens?: number;
    readonly text_tokens?: number;
  };
}

/** `response.done.response` 的终态快照 */
export interface RealtimeResponseSnapshot {
  readonly status?: string;
  /** 助手消息和 `function_call` 项都在这里；item id 从这里拿最稳 */
  readonly output?: readonly RealtimeResponseOutputItem[];
  readonly usage?: RealtimeResponseUsage;
}

/**
 * DashScope `/api-ws/v1/realtime` 的服务端事件。
 *
 * 判别字段一律 `readonly type: '...'`，所以 `case` 分支里能真正窄化到具体字段。
 */
export type DashScopeRealtimeEvent =
  | { readonly type: 'session.updated' }
  | {
    readonly type: 'conversation.item.created';
    readonly item?: RealtimeItemRef;
  }
  | {
    /** ASR 增量：实测增量在 `stash`，`text` 恒为空串 */
    readonly type: 'conversation.item.input_audio_transcription.text';
    readonly text?: string;
    readonly stash?: string;
  }
  | {
    readonly type: 'conversation.item.input_audio_transcription.completed';
    readonly transcript?: string;
  }
  | {
    readonly type: 'conversation.item.input_audio_transcription.failed';
    readonly error?: RealtimeErrorDetail;
  }
  | { readonly type: 'input_audio_buffer.committed' }
  | { readonly type: 'response.created' }
  | {
    readonly type: 'response.output_item.added';
    readonly item?: RealtimeItemRef;
  }
  | {
    readonly type: 'response.text.delta';
    readonly delta?: string;
  }
  | {
    readonly type: 'response.audio_transcript.delta';
    readonly delta?: string;
  }
  | {
    readonly type: 'response.function_call_arguments.delta';
    readonly delta?: string;
    readonly call_id?: string;
  }
  | {
    /** 完整参数在这一条里（delta 是分段，拼起来容易漏引号） */
    readonly type: 'response.function_call_arguments.done';
    readonly call_id?: string;
    readonly arguments?: unknown;
  }
  | {
    readonly type: 'response.audio.delta';
    readonly delta?: string;
  }
  | {
    readonly type: 'response.done';
    readonly response?: RealtimeResponseSnapshot;
  }
  | {
    readonly type: 'error';
    readonly error?: RealtimeErrorDetail;
  };

/** 只保留 `response.done` 的窄类型（`assistantItemIds` / `finish` 用） */
export type RealtimeResponseDoneEvent = Extract<
  DashScopeRealtimeEvent,
  { readonly type: 'response.done' }
>;

/** 只保留 `error` 的窄类型（`onError` 用） */
export type RealtimeErrorEvent = Extract<
  DashScopeRealtimeEvent,
  { readonly type: 'error' }
>;
