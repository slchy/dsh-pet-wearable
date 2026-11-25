/**
 * 立绘选择。文件名必须与 `src/host-mount.ts` 的 `PET_SPRITE_NAMES` 全等，
 * 但不要从那边 import：宿主模块会把 Node 依赖带进浏览器包。
 * 双端锁在 `tests/pet-sprites.test.ts`。
 *
 * 说话盖过倾听，倾听盖过预览，预览盖过保持中的情绪，其余是平静。
 * `thinking` 没有自己的图。倾听和说话都不清预览，免得相位一过预览就丢了。
 */

export const SPRITE_NAMES = [
  'calm',
  'speaking',
  'listening',
  'happy',
  'proud',
  'surprised',
  'worried',
  'sulk',
  'angry',
  'disgust',
] as const;

export type SpriteName = typeof SPRITE_NAMES[number];

const HOLD_EMOTIONS = ['happy', 'proud', 'surprised', 'worried', 'sulk', 'angry', 'disgust'] as const;
export type HoldEmotion = typeof HOLD_EMOTIONS[number];
export type ActiveEmotion = HoldEmotion | 'calm';
export type SpritePhase = 'idle' | 'listening' | 'thinking' | 'speaking';

export const EMOTION_HOLD_MS = 4500;

export const SPRITE_LABELS: Record<SpriteName, string> = {
  calm: '平静',
  speaking: '说话',
  listening: '倾听',
  happy: '开心',
  proud: '得意',
  surprised: '惊讶',
  worried: '担心',
  sulk: '委屈',
  angry: '生气',
  disgust: '厌恶',
};

export interface SpriteState {
  readonly speaking: boolean;
  readonly phase: SpritePhase;
  readonly previewName: SpriteName | null;
  readonly previewUntil: number;
  readonly activeEmotion: ActiveEmotion;
  readonly emotionUntil: number;
}

export interface SpriteSelection {
  readonly name: SpriteName;
  readonly state: SpriteState;
}

export function initialSpriteState(): SpriteState {
  return {
    speaking: false,
    phase: 'idle',
    previewName: null,
    previewUntil: 0,
    activeEmotion: 'calm',
    emotionUntil: 0,
  };
}

export function spriteUrl(name: SpriteName): string {
  return `/dsh-voice/assets/${name}.webp`;
}

function isHoldEmotion(value: string): value is HoldEmotion {
  return (HOLD_EMOTIONS as readonly string[]).includes(value);
}

export function selectSprite(state: SpriteState, now: number): SpriteSelection {
  if (state.speaking) return { name: 'speaking', state };
  if (state.phase === 'listening') return { name: 'listening', state };
  if (state.previewName !== null && now < state.previewUntil) {
    return { name: state.previewName, state };
  }
  const cleared = state.previewName === null ? state : { ...state, previewName: null };
  if (cleared.activeEmotion !== 'calm' && now < cleared.emotionUntil) {
    return { name: cleared.activeEmotion, state: cleared };
  }
  return { name: 'calm', state: cleared };
}

export function armEmotion(state: SpriteState, raw: string, now: number): SpriteState {
  const activeEmotion: ActiveEmotion = isHoldEmotion(raw) ? raw : 'calm';
  return {
    ...state,
    previewName: null,
    activeEmotion,
    emotionUntil: activeEmotion === 'calm' ? 0 : now + EMOTION_HOLD_MS,
  };
}

export function armPreview(state: SpriteState, name: SpriteName, now: number): SpriteState {
  const previewUntil = now + EMOTION_HOLD_MS;
  if (name === 'speaking' || name === 'listening') {
    return { ...state, previewName: name, previewUntil };
  }
  if (!isHoldEmotion(name)) {
    return {
      ...state,
      previewName: name,
      previewUntil,
      activeEmotion: 'calm',
      emotionUntil: 0,
    };
  }
  return {
    ...state,
    previewName: name,
    previewUntil,
    activeEmotion: name,
    emotionUntil: previewUntil,
  };
}

/** 最近一个还没到的截止点再加 16ms。没有未来时刻就不上定时器。 */
export function nextSpriteDelay(state: SpriteState, now: number): number | null {
  const deadlines = [state.previewUntil, state.emotionUntil].filter((time) => time > now);
  if (deadlines.length === 0) return null;
  const wait = Math.max(0, Math.min(...deadlines) - now);
  return wait + 16;
}
