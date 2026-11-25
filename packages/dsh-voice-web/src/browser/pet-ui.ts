/**
 * 桌宠界面状态机。不碰 DOM、不定时器。
 *
 * 效果标签交给入口去画和上钟：`render-expression` / `render-status` /
 * `poke-captions` / `flash-note` / `stop-speaking`。
 * 4503 挂担心表情并亮 4500ms 提示；1000 正常关闭不闪注。
 * 气泡悬停不续期，离开才按闲置时长重约。
 */
import {
  armEmotion,
  initialSpriteState,
  type ActiveEmotion,
  type SpriteName,
  type SpritePhase,
  type SpriteState,
} from './pet-sprites.ts';

export type PetUiPhase = SpritePhase;
export type ReplyPath = 'omni' | 'fast' | 'dsh';
export type LinkState = 'off' | 'connecting' | 'live';

/** 与 `client.ts` 的 `PetUiEvent` 同形。不 import 那个模块，避免 Node 测试拽进 DOM。 */
export type PetUiEvent =
  | { readonly type: 'phase'; readonly phase: PetUiPhase }
  | { readonly type: 'asr'; readonly text: string; readonly final: boolean }
  | { readonly type: 'asr.replace'; readonly text: string; readonly previous?: string }
  | { readonly type: 'reply.delta'; readonly delta: string; readonly path?: ReplyPath }
  | { readonly type: 'reply.final'; readonly text: string; readonly emotion: string; readonly path?: ReplyPath }
  | { readonly type: 'delegated'; readonly query: string; readonly reason?: string }
  | { readonly type: 'announce'; readonly text: string; readonly emotion: string };

/** 与 `client.ts` 的 `VoiceClientEvent` 同形。 */
export type PetClientEvent =
  | { readonly type: 'open' }
  | { readonly type: 'ready' }
  | { readonly type: 'control'; readonly text: string }
  | { readonly type: 'call'; readonly json: unknown }
  | { readonly type: 'speaking'; readonly active: boolean }
  | { readonly type: 'ui'; readonly event: PetUiEvent }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'close'; readonly code: number; readonly reason: string };

export const BUBBLE_IDLE_MS = 7000;
export const NOTE_MS = 1600;
export const CLOSE_NOTE_MS = 4500;
export const CLOSE_NOTE_FALLBACK = '语音后端未就绪，请检查 ~/.dsh/.env 凭据';

export type PetEffect =
  | { readonly type: 'render-expression'; readonly schedule: boolean }
  | { readonly type: 'render-status' }
  | { readonly type: 'poke-captions'; readonly render: boolean }
  | { readonly type: 'flash-note'; readonly text: string; readonly durationMs: number }
  | { readonly type: 'stop-speaking' };

export interface PetUiState {
  readonly link: LinkState;
  readonly phase: PetUiPhase;
  readonly speaking: boolean;
  readonly asrText: string;
  readonly replyText: string;
  readonly replyPath: ReplyPath | undefined;
  readonly replySealed: boolean;
  readonly delegated: boolean;
  readonly captionsOn: boolean;
  readonly noteText: string;
  readonly bubbleHover: boolean;
  readonly showBubble: boolean;
  readonly headphoneHintDismissed: boolean;
  readonly previewName: SpriteName | null;
  readonly previewUntil: number;
  readonly activeEmotion: ActiveEmotion;
  readonly emotionUntil: number;
}

export interface PetUiReduction {
  readonly state: PetUiState;
  readonly effects: readonly PetEffect[];
}

export interface BubbleView {
  readonly hintHidden: boolean;
  readonly asrHidden: boolean;
  readonly asrText: string;
  readonly replyHidden: boolean;
  readonly laneHidden: boolean;
  readonly laneText: string;
  readonly replyText: string;
  readonly badgeHidden: boolean;
  readonly noteHidden: boolean;
  readonly noteText: string;
  readonly visible: boolean;
}

export interface StatusView {
  readonly mode: 'off' | 'connecting' | 'speaking' | 'live';
  readonly className: string;
  readonly label: string;
  readonly micLabel: string;
  readonly micPressed: boolean;
}

export function initialPetUiState(prefs: {
  readonly showBubble?: boolean;
  readonly headphoneHintDismissed?: boolean;
} = {}): PetUiState {
  const sprite = initialSpriteState();
  return {
    link: 'off',
    phase: sprite.phase,
    speaking: sprite.speaking,
    asrText: '',
    replyText: '',
    replyPath: undefined,
    replySealed: true,
    delegated: false,
    captionsOn: false,
    noteText: '',
    bubbleHover: false,
    showBubble: prefs.showBubble !== false,
    headphoneHintDismissed: prefs.headphoneHintDismissed === true,
    previewName: sprite.previewName,
    previewUntil: sprite.previewUntil,
    activeEmotion: sprite.activeEmotion,
    emotionUntil: sprite.emotionUntil,
  };
}

export function spriteStateOf(state: PetUiState): SpriteState {
  return {
    speaking: state.speaking,
    phase: state.phase,
    previewName: state.previewName,
    previewUntil: state.previewUntil,
    activeEmotion: state.activeEmotion,
    emotionUntil: state.emotionUntil,
  };
}

export function adoptSprite(state: PetUiState, sprite: SpriteState): PetUiState {
  return {
    ...state,
    previewName: sprite.previewName,
    previewUntil: sprite.previewUntil,
    activeEmotion: sprite.activeEmotion,
    emotionUntil: sprite.emotionUntil,
  };
}

export function laneLabel(path: ReplyPath | undefined): string {
  if (path === 'dsh') return 'L2';
  if (path === 'omni' || path === 'fast') return 'L1';
  return '';
}

export function bubbleView(state: PetUiState): BubbleView {
  const captions = state.showBubble && state.captionsOn;
  const hintHidden = state.headphoneHintDismissed || !state.showBubble;
  const showAsr = captions && state.asrText.trim() !== '';
  const showReply = captions && state.replyText.trim() !== '';
  const laneText = laneLabel(state.replyPath);
  const badgeHidden = !(captions && state.delegated);
  const noteHidden = state.noteText === '';
  return {
    hintHidden,
    asrHidden: !showAsr,
    asrText: state.asrText,
    replyHidden: !showReply,
    laneHidden: laneText === '',
    laneText,
    replyText: state.replyText,
    badgeHidden,
    noteHidden,
    noteText: state.noteText,
    visible: !hintHidden || showAsr || showReply || !badgeHidden || state.noteText !== '',
  };
}

export function statusView(state: PetUiState): StatusView {
  const mode = state.link === 'off'
    ? 'off'
    : state.link === 'connecting'
      ? 'connecting'
      : state.speaking
        ? 'speaking'
        : 'live';
  const label = mode === 'off'
    ? '未连接'
    : mode === 'connecting'
      ? '正在连接'
      : mode === 'speaking'
        ? '说话中'
        : state.phase === 'listening'
          ? '聆听中'
          : '通话中';
  const live = state.link !== 'off';
  return {
    mode,
    className: `pet-dot is-${mode}`,
    label,
    micLabel: live ? '挂断' : '开启通话',
    micPressed: live,
  };
}

function poke(state: PetUiState): PetUiState {
  return { ...state, captionsOn: true };
}

function expression(schedule: boolean): PetEffect {
  return { type: 'render-expression', schedule };
}

/** 悬停只记账。离开才把闲置计时整段重约，不把已经亮着的字幕续命。 */
export function markBubbleHover(state: PetUiState, hover: boolean): PetUiReduction {
  if (hover) return { state: { ...state, bubbleHover: true }, effects: [] };
  return {
    state: { ...state, bubbleHover: false },
    effects: [{ type: 'poke-captions', render: false }],
  };
}

/** 到点时如果指针还在气泡上，字幕留着，也不再约下一次。 */
export function dismissIdleBubble(state: PetUiState): PetUiState {
  if (state.bubbleHover) return state;
  return { ...state, captionsOn: false, delegated: false };
}

function withSpeaking(state: PetUiState, active: boolean): PetUiReduction {
  if (active === state.speaking) {
    return { state, effects: [{ type: 'render-status' }] };
  }
  if (active) {
    return {
      state: { ...state, speaking: true },
      effects: [expression(false), { type: 'render-status' }],
    };
  }
  return {
    state: { ...state, speaking: false },
    effects: [
      { type: 'stop-speaking' },
      expression(false),
      { type: 'render-status' },
    ],
  };
}

export function reducePetUi(state: PetUiState, event: PetUiEvent, now: number): PetUiReduction {
  switch (event.type) {
    case 'phase':
      return {
        state: { ...state, phase: event.phase },
        effects: [expression(false), { type: 'render-status' }],
      };
    case 'asr':
      return {
        state: poke({ ...state, delegated: false, asrText: event.text }),
        effects: [{ type: 'poke-captions', render: true }],
      };
    case 'asr.replace': {
      const next = event.text.trim();
      if (next === '') return { state, effects: [] };
      if (event.previous !== undefined && state.asrText.trim() !== event.previous.trim()) {
        return { state, effects: [] };
      }
      return {
        state: poke({ ...state, asrText: next }),
        effects: [{ type: 'poke-captions', render: true }],
      };
    }
    case 'reply.delta':
      // 上一条已经收口时，下一次 delta 另起一段，避免叠在旧回复后面。
      return {
        state: poke({
          ...state,
          replyText: state.replySealed ? event.delta : state.replyText + event.delta,
          replySealed: false,
          replyPath: event.path,
        }),
        effects: [{ type: 'poke-captions', render: true }],
      };
    case 'reply.final':
      return {
        state: poke({
          ...adoptSprite(state, armEmotion(spriteStateOf(state), event.emotion, now)),
          replyText: event.text,
          replyPath: event.path,
          replySealed: true,
        }),
        effects: [expression(true), { type: 'poke-captions', render: true }],
      };
    case 'announce':
      return {
        state: poke({
          ...adoptSprite(state, armEmotion(spriteStateOf(state), event.emotion, now)),
          replyText: event.text,
          replyPath: undefined,
          replySealed: true,
        }),
        effects: [expression(true), { type: 'poke-captions', render: true }],
      };
    case 'delegated':
      return {
        state: poke({ ...state, delegated: true }),
        effects: [{ type: 'poke-captions', render: true }],
      };
    default: {
      const unreachable: never = event;
      void unreachable;
      return { state, effects: [] };
    }
  }
}

export function reduceClientEvent(
  state: PetUiState,
  event: PetClientEvent,
  now: number,
): PetUiReduction {
  switch (event.type) {
    case 'open':
    case 'ready':
      return {
        state: { ...state, link: 'live' },
        effects: [{ type: 'render-status' }],
      };
    case 'speaking':
      return withSpeaking(state, event.active);
    case 'ui':
      return reducePetUi(state, event.event, now);
    case 'error':
      if (event.message === '') return { state, effects: [] };
      return {
        state: { ...state, noteText: event.message },
        effects: [{ type: 'flash-note', text: event.message, durationMs: NOTE_MS }],
      };
    case 'close': {
      const transition = withSpeaking({ ...state, link: 'off', phase: 'idle' }, false);
      let next = transition.state;
      const effects: PetEffect[] = [...transition.effects];
      if (event.code === 4503 || (event.code !== 1000 && event.reason !== '')) {
        const text = event.reason !== '' ? event.reason : CLOSE_NOTE_FALLBACK;
        next = {
          ...adoptSprite(next, armEmotion(spriteStateOf(next), 'worried', now)),
          noteText: text,
        };
        effects.push(expression(true));
        effects.push({ type: 'flash-note', text, durationMs: CLOSE_NOTE_MS });
      }
      effects.push(expression(false));
      effects.push({ type: 'render-status' });
      return { state: next, effects };
    }
    case 'control':
    case 'call':
      return { state, effects: [] };
    default: {
      const unreachable: never = event;
      void unreachable;
      return { state, effects: [] };
    }
  }
}
