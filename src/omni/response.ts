/**
 * 一份 `PendingResponse` 上的纯操作：相位、独占读端、不跨 `next` 的 solo 流。
 * 不碰 socket，也不碰上行账本。
 */
import type { AudioCursor, PendingResponse, ResponseOrigin, SealMeta } from './types.ts';

/** 一份还没开张的回复。`sendSeal` / `speakFromText` / `answerFromText` 共用，避免哪边漏字段。 */
export function blankPending(meta: SealMeta, origin: ResponseOrigin, sentAt: number): PendingResponse {
  return {
    meta,
    origin,
    sentAt,
    ackAt: null,
    finalAt: null,
    firstTextAt: null,
    firstAudioAt: null,
    outBytes: 0,
    phase: 'starting',
    endedByCancel: false,
    audio: [],
    readerEpoch: 0,
    audioWaiters: [],
    text: '',
    delegate: null,
    delegateRequest: null,
    superseded: false,
    next: null,
    deleteOnDone: false,
    itemIds: [],
    userItemId: null,
    delegateCallId: null,
    deletePromptUserOnDone: false,
    claimed: false,
  };
}

/** 取消已经提出，或收尾时就是取消。`starting` / `live` 不是。 */
export function isCancelled(resp: PendingResponse): boolean {
  return resp.phase === 'cancel_when_created'
    || resp.phase === 'cancelling'
    || (resp.phase === 'done' && resp.endedByCancel);
}

/** `response.done` 已到，或本地把这份收口了。 */
export function isClosed(resp: PendingResponse): boolean {
  return resp.phase === 'done';
}

/** 读端该停了：已经在取消，或者已经收口。 */
export function isSettled(resp: PendingResponse): boolean {
  return isClosed(resp) || isCancelled(resp);
}

/**
 * 收口。`byCancel` 用来把「排队项还没发出去就被扔掉」也记成取消。
 * 已经是 `done` 时直接返回：二次调用不许改 `endedByCancel`。
 */
export function markPhaseDone(resp: PendingResponse, byCancel = false): void {
  if (resp.phase === 'done') {
    return;
  }
  resp.endedByCancel = byCancel
    || resp.phase === 'cancel_when_created'
    || resp.phase === 'cancelling';
  resp.phase = 'done';
}

/** 新的独占读端。旧游标的 epoch 对不上，下一次取块就停。 */
export function openExclusiveReader(resp: PendingResponse): AudioCursor {
  resp.readerEpoch += 1;
  return { index: 0, epoch: resp.readerEpoch };
}

/** 这条回复从建出来就只有一个读端（后台汇报 / 文本直答 / 排队发声）。 */
export function openSoloReader(resp: PendingResponse): AudioCursor {
  return { index: 0, epoch: resp.readerEpoch };
}

export function takeChunk(resp: PendingResponse, cursor: AudioCursor): Buffer | 'wait' | 'stale' {
  if (cursor.epoch !== resp.readerEpoch) {
    return 'stale';
  }
  const chunk = resp.audio[cursor.index];
  if (chunk === undefined) {
    return 'wait';
  }
  cursor.index += 1;
  return chunk;
}

/** 后台汇报 / 文本直答 / 排队发声共用的读端：停在自己这份上，不跟 `next`。 */
export async function* iterateSolo(resp: PendingResponse): AsyncGenerator<Buffer> {
  const cursor = openSoloReader(resp);
  for (;;) {
    const chunk = takeChunk(resp, cursor);
    if (chunk === 'stale') {
      return;
    }
    if (chunk !== 'wait') {
      yield chunk;
      continue;
    }
    if (isSettled(resp)) {
      return;
    }
    await new Promise<void>((resolve) => {
      resp.audioWaiters.push(resolve);
    });
  }
}

/** 读端要的三项：绑的是「这一份」对象，并段跟过去之后也读到新的那份。 */
export function liveControls(read: () => PendingResponse | null): {
  delegateCallId: () => string | null;
  userItemId: () => string | null;
  assistantItemIds: () => readonly string[];
} {
  return {
    delegateCallId: () => read()?.delegateCallId ?? null,
    userItemId: () => read()?.userItemId ?? null,
    assistantItemIds: () => [...(read()?.itemIds ?? [])],
  };
}

export function wakeAudio(resp: PendingResponse | null): void {
  if (resp === null) {
    return;
  }
  const waiters = resp.audioWaiters;
  resp.audioWaiters = [];
  for (const wake of waiters) {
    wake();
  }
}
