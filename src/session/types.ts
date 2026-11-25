/**
 * 会话公开类型，以及门面管道与轮次机之间的事件 / 效果。
 *
 * 效果是显式数据：轮次机不持有 `DshSession`，也不直接碰播报回调。
 */
import type { TokenUsage } from './usage.ts';

export interface AskResult {
  text: string;
  /** 本次实际使用的会话 id（新会话时是刚拿到的） */
  sessionId: string | null;
  usage: TokenUsage | null;
  durationMs: number;
  /** 首个输出 token 的耗时（ms）。没有流式钩子时缺席 —— 缺了记 undefined，不拿 0 冒充 */
  firstTokenMs?: number;
  /** 是否沿用了已有会话 */
  resumed: boolean;
  /**
   * 这一轮被**放手**了（见 `detachTurn`）：dsh 还在跑，答案之后从播报口出来。
   *
   * 上层看到它就别把空 `text` 当失败 —— 那只是「这一轮不再等它」。
   */
  detached?: boolean;
}

/**
 * 随提示一起下发的图片（ACP `image` content block）。
 *
 * 实测（2026-11-06）：`deepseek-flash` 的 `input_modalities` 是 `["text","image"]`，
 * 而 dsh 的 ACP 层本来就支持 image 块，mimeType 只收
 * png / jpeg / webp / gif，且 data 必须是**标准 base64**（不能带 `data:` 前缀）。
 */
export interface ImageAttachment {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** 标准 base64，不带 data URL 前缀 */
  data: string;
}

export interface SessionOptions {
  /**
   * dsh 可执行文件。服务器上 `~/node22/bin` 只在交互式 zsh 的 PATH 里，
   * 非交互式（systemd / ssh 命令）拿不到，所以建议用 DSH_BIN 指定绝对路径。
   */
  program?: string;
  /** 固定工作目录：既是 dsh 的 cwd，也是沙箱的 workspaceRoot */
  workDir: string;
  /**
   * 会话 id 的持久化位置。不给就看环境变量 `VOICE_AGENT_SESSION`，
   * 再没有才是 ~/.voice-agent/session.json（见文件头：第二个实例必须换路径）。
   */
  sessionFile?: string;
  timeoutMs?: number;
  /** 额外的 profile patch 文件（用于挂 MCP 工具等） */
  patch?: string;
  log?: (line: string) => void;
  /**
   * 调用方式。
   *
   * - `headless`：每轮起一个新进程（`dsh headless --json`），简单但每轮多 2–3 s 冷启动。
   * - `sdk`：一个常驻进程通过 stdio JSON-RPC 服务多轮（`dsh --profile sdk`），
   *   省掉进程启动与会话重加载。会话 id 由客户端指定，所以首次自己生成。
   */
  mode?: 'headless' | 'sdk';
  /** sdk 模式必填：provider 路由，实测为 deepseek-official */
  provider?: string;
  /** sdk 模式必填：模型名。实测可用 deepseek-flash / deepseek-v4-pro */
  model?: string;
  /**
   * 流式门槛：这么多 token 之内不流式，超了才把缓冲一次性放出去。
   *
   * 默认 20 —— 语音回复的中位长度就在这附近，短答走流式只会多几次 TTS 调用。
   */
  liveTokenThreshold?: number;
}

export class DshError extends Error {}

/**
 * 主会话一轮的相位。`askSdk` 的 `finally` 只按它归位：
 * `session/prompt` 抛错时不能把 `onIdle` 留在槽上，否则 `isBusy()` 永远为真。
 *
 * - `idle`：没有在等的主轮，也没有放手后还在跑的委派轮
 * - `prompting_rpc`：正在等 `session/prompt` 的响应
 * - `awaiting_idle`：prompt 已被接受，在等这条主会话的 `idle`
 * - `detached_running`：调用方已经放手，dsh 那一轮还在跑
 */
export type DshTurnPhase = 'idle' | 'prompting_rpc' | 'awaiting_idle' | 'detached_running';

/** 轮次机交给门面执行的效果。机器自己不调用播报回调。 */
export type TurnEffect =
  | { readonly type: 'log'; readonly line: string }
  | {
    readonly type: 'detached-answer';
    readonly userText: string;
    readonly answer: string;
    readonly spoken: boolean;
  }
  | { readonly type: 'announce'; readonly text: string };

/** `cancelTurn` 的决定。RPC 与宽限定时由门面执行。 */
export type CancelDecision =
  | { readonly type: 'noop' }
  | { readonly type: 'stale'; readonly line: string }
  | {
    readonly type: 'cancel';
    readonly sessionId: string;
    readonly graceWaiter: (() => void) | null;
    readonly droppedLease: boolean;
  };

/** sdk 解析后交回门面的 JSON-RPC 通知。响应在传输层就地结算。 */
export interface JsonRpcNotice {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface SessionEventFrame {
  readonly kind: 'event';
  readonly sessionId: string;
  readonly type: string;
  readonly seq: number | null;
  readonly inserted: number;
  readonly data: Record<string, unknown> | undefined;
  readonly event: Record<string, unknown>;
}

export interface SessionStatusFrame {
  readonly kind: 'status';
  readonly sessionId: unknown;
  readonly status: string;
}

export type SessionFrame = SessionEventFrame | SessionStatusFrame;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** 只认出主会话的两类通知。别的方法、坏帧都丢掉。 */
export function classifySessionFrame(note: JsonRpcNotice): SessionFrame | null {
  if (note.method === 'session.event') {
    const raw = note.params['event'];
    if (raw === null || typeof raw !== 'object') return null;
    const event = raw as Record<string, unknown>;
    const data = asRecord(event['data']);
    const inserted = data?.['inserted'];
    const seq = event['seq'];
    const sessionId = note.params['sessionId'];
    const type = event['type'];
    return {
      kind: 'event',
      sessionId: typeof sessionId === 'string' ? sessionId : '',
      type: typeof type === 'string' ? type : '',
      seq: typeof seq === 'number' ? seq : null,
      inserted: Array.isArray(inserted) ? inserted.length : 0,
      data,
      event,
    };
  }
  if (note.method === 'session.status') {
    const status = note.params['status'];
    return {
      kind: 'status',
      sessionId: note.params['sessionId'],
      status: typeof status === 'string' ? status : '',
    };
  }
  return null;
}
