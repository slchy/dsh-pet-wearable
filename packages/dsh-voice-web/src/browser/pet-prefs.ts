/**
 * 桌宠偏好：锚点、尺寸、镜像、字幕、右缘避让、耳机提示、动态音效。
 *
 * 滑条只到 240，存档可以到 260——已经放大过的尺寸不会因为打开面板被悄悄改小，
 * 直到用户真的去拖滑条。右缘避让没有上限，小于等于 0 收成 0。
 * 音效两个开关只认显式布尔：旧存档缺字段时 `soundEnabled` 回 true、
 * `retroSpark` 回 false，音量默认开着，彩蛋默认不吵人。
 */
import { clamp, type SavedAnchorPos } from './pet-geometry.ts';

export const PREFS_KEY = 'dsh-voice-pet-v1';
export const DEFAULT_SIZE_PX = 144;
export const SIZE_MIN_PX = 96;
export const SIZE_STORE_MAX_PX = 260;
export const SIZE_SLIDER_MAX_PX = 240;
export const DEFAULT_RIGHT_GAP = 12;

export interface PetPrefs {
  anchor: SavedAnchorPos | null;
  sizePx: number;
  mirrorOnLeft: boolean;
  showBubble: boolean;
  rightGap: number;
  headphoneHintDismissed: boolean;
  soundEnabled: boolean;
  retroSpark: boolean;
}

interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function defaultPrefs(): PetPrefs {
  return {
    anchor: null,
    sizePx: DEFAULT_SIZE_PX,
    mirrorOnLeft: false,
    showBubble: true,
    rightGap: DEFAULT_RIGHT_GAP,
    headphoneHintDismissed: false,
    soundEnabled: true,
    retroSpark: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readAnchor(value: unknown): SavedAnchorPos | null {
  if (!isRecord(value)) return null;
  const hAnchor = value['hAnchor'];
  const vAnchor = value['vAnchor'];
  const hSnapped = value['hSnapped'];
  const vSnapped = value['vSnapped'];
  const hDist = value['hDist'];
  const vDist = value['vDist'];
  if (value['v'] !== 2) return null;
  if (hAnchor !== 'left' && hAnchor !== 'right') return null;
  if (vAnchor !== 'top' && vAnchor !== 'bottom') return null;
  if (hSnapped !== 'left' && hSnapped !== 'right' && hSnapped !== null) return null;
  if (vSnapped !== 'top' && vSnapped !== 'bottom' && vSnapped !== null) return null;
  if (typeof hDist !== 'number' || typeof vDist !== 'number') return null;
  if (!Number.isFinite(hDist) || !Number.isFinite(vDist)) return null;
  return { v: 2, hAnchor, hDist, vAnchor, vDist, hSnapped, vSnapped };
}

function readSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SIZE_PX;
  return clamp(Math.round(value), SIZE_MIN_PX, SIZE_STORE_MAX_PX);
}

function readGap(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_RIGHT_GAP;
  return value > 0 ? value : 0;
}

function prefsFromParsed(value: unknown): PetPrefs {
  const prefs = defaultPrefs();
  if (!isRecord(value)) return prefs;
  prefs.anchor = readAnchor(value['anchor']);
  prefs.sizePx = readSize(value['sizePx']);
  prefs.mirrorOnLeft = value['mirrorOnLeft'] === true;
  prefs.showBubble = value['showBubble'] !== false;
  prefs.rightGap = readGap(value['rightGap']);
  prefs.headphoneHintDismissed = value['headphoneHintDismissed'] === true;
  prefs.soundEnabled = value['soundEnabled'] !== false;
  prefs.retroSpark = value['retroSpark'] === true;
  return prefs;
}

/** 字符串按 JSON 解析；对象按已解析的存档收。坏 JSON、空串、非对象都回到默认。 */
export function parsePrefs(value: unknown): PetPrefs {
  if (typeof value === 'string') {
    try {
      if (value === '') return defaultPrefs();
      return prefsFromParsed(JSON.parse(value) as unknown);
    } catch {
      return defaultPrefs();
    }
  }
  return prefsFromParsed(value);
}

export function serializePrefs(prefs: PetPrefs): string {
  return JSON.stringify({
    anchor: prefs.anchor,
    sizePx: prefs.sizePx,
    mirrorOnLeft: prefs.mirrorOnLeft,
    showBubble: prefs.showBubble,
    rightGap: prefs.rightGap,
    headphoneHintDismissed: prefs.headphoneHintDismissed,
    soundEnabled: prefs.soundEnabled,
    retroSpark: prefs.retroSpark,
  });
}

/** 滑条写回：四舍五入后夹到 96..240，不把存档上限 260 写回去。 */
export function clampSliderSize(value: number): number {
  return clamp(Math.round(value), SIZE_MIN_PX, SIZE_SLIDER_MAX_PX);
}

function browserStorage(): PrefsStorage | null {
  const scope = globalThis as { localStorage?: PrefsStorage };
  try {
    const store = scope.localStorage;
    if (store === undefined || store === null) return null;
    if (typeof store.getItem !== 'function' || typeof store.setItem !== 'function') return null;
    return store;
  } catch {
    return null;
  }
}

export function loadPrefs(storage?: PrefsStorage): PetPrefs {
  const store = storage ?? browserStorage();
  if (store === null) return defaultPrefs();
  try {
    const raw = store.getItem(PREFS_KEY);
    if (raw === null || raw === '') return defaultPrefs();
    return parsePrefs(raw);
  } catch {
    return defaultPrefs();
  }
}

export function savePrefs(prefs: PetPrefs, storage?: PrefsStorage): void {
  const store = storage ?? browserStorage();
  if (store === null) return;
  try {
    store.setItem(PREFS_KEY, serializePrefs(prefs));
  } catch {
    // 隐私模式拒写时，这一会话里的位置仍然留在内存里。
  }
}
