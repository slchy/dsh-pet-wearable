/**
 * Gemini-chan 浮层桌宠。
 *
 * 外壳锁在浅色 DOM 的固定宿主上，内部全部进 Shadow DOM：dsh 的皮肤进不来，
 * 立绘的样式也漏不出去。几何（吸附、锚点、凸包）只调 `pet-geometry.ts`。
 * 按压回弹和透明穿透的口径来自 dsh-whale-widget@0.3.16
 * （MIT, Copyright (c) 2026 MeteorNOX），这里按语音桌宠重写过。
 */
import {
  createVoiceClient,
  type PetUiEvent,
  type PetUiPhase,
  type VoiceClient,
  type VoiceClientEvent,
} from './client.ts';
import {
  CLICK_DISTANCE_SQ,
  DEFAULT_SNAP_CONFIG,
  PRESS_SPRING_TRANSITION,
  PRESS_SQUISH_TRANSFORM,
  anchorFromDrop,
  buildAlphaClipPath,
  clamp,
  hasOpaqueProbePixels,
  resolveAnchorPosition,
  shouldMirrorArt,
  shouldRevertDrag,
  type SavedAnchorPos,
} from './pet-geometry.ts';

const MOUNT_KEY = '__DSH_VOICE_PET_MOUNTED__';
const PREFS_KEY = 'dsh-voice-pet-v1';
const HOST_ID = 'dsh-voice-pet-host';
const GUARD_STYLE_ID = 'dsh-voice-pet-host-guard';
const HIT_SIZE = 256;
const ALPHA_THRESHOLD = 10;
const DEFAULT_SIZE_PX = 144;
const SIZE_MIN_PX = 96;
const SIZE_STORE_MAX_PX = 260;
const SIZE_SLIDER_MAX_PX = 240;
const DEFAULT_RIGHT_GAP = 12;
const EMOTION_HOLD_MS = 4500;
const BUBBLE_IDLE_MS = 7000;
const NOTE_MS = 1600;
const HOST_MOVE = 'left .16s ease, top .16s ease';

const SPRITE_NAMES = [
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

type SpriteName = typeof SPRITE_NAMES[number];

const HOLD_EMOTIONS = ['happy', 'proud', 'surprised', 'worried', 'sulk', 'angry', 'disgust'] as const;
type HoldEmotion = typeof HOLD_EMOTIONS[number];
type ActiveEmotion = HoldEmotion | 'calm';
type ReplyPath = 'omni' | 'fast' | 'dsh';
type LinkState = 'off' | 'connecting' | 'live';
type BubbleSide = 'left' | 'right';

const SPRITE_LABELS: Record<SpriteName, string> = {
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

/** 写在 document.head，压过按 fixed + z-index 套毛玻璃的宿主皮肤。 */
const HOST_GUARD_CSS = [
  'html #dsh-voice-pet-host, body #dsh-voice-pet-host { position: fixed !important; background: transparent !important; background-image: none !important; border: 0 !important; outline: 0 !important; box-shadow: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; filter: none !important; pointer-events: none !important; z-index: 9998 !important; padding: 0 !important; margin: 0 !important; }',
  'html #dsh-voice-pet-host::before, html #dsh-voice-pet-host::after { content: none !important; display: none !important; }',
].join('\n');

const WIDGET_CSS = `
:host {
  display: block;
  width: 100%;
  height: 100%;
  color-scheme: light dark;
  font: 13px/1.45 ui-sans-serif, system-ui, "Segoe UI", sans-serif;
}
:host, :host *, :host *::before, :host *::after { box-sizing: border-box; }
.pet-root, .pet-root * { -webkit-tap-highlight-color: transparent; }
.pet-root {
  position: relative;
  width: var(--pet-size, 140px);
  height: var(--pet-size, 140px);
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}
.pet-mirror, .pet-squish, .pet-talk {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.pet-squish { transform-origin: 50% 100%; }
.pet-talk { transform-origin: 50% 92%; will-change: transform; }
.pet-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: center;
  pointer-events: auto;
  -webkit-user-drag: none;
  user-select: none;
  touch-action: none;
}
.pet-root.cursor-grab .pet-img { cursor: grab; }
.pet-root.cursor-grabbing .pet-img { cursor: grabbing; }
.pet-img:focus-visible { outline: 2px solid #7c6df0; outline-offset: 2px; }
.pet-bubble, .pet-panel {
  --card: rgba(255, 252, 248, 0.9);
  --ink: #241b32;
  --muted: #6d6280;
  position: absolute;
  top: 0;
  z-index: 4;
  max-width: min(280px, calc(100vw - 24px));
  color: var(--ink);
  background: var(--card);
  border: 1px solid #7c6df0;
  border-radius: 14px;
  box-shadow: 0 10px 28px rgba(36, 24, 64, 0.16), inset 0 1px 0 rgba(226, 177, 90, 0.5);
  backdrop-filter: blur(14px) saturate(1.15);
  -webkit-backdrop-filter: blur(14px) saturate(1.15);
  pointer-events: auto;
}
.pet-bubble {
  padding: 8px 10px;
  max-height: 30vh;
  overflow: auto;
  opacity: 0;
  visibility: hidden;
  transition: opacity .45s ease, visibility 0s linear .45s;
}
.pet-bubble.show {
  opacity: 1;
  visibility: visible;
  transition: opacity .45s ease, visibility 0s linear 0s;
}
.pet-bubble.side-left, .pet-panel.side-left { right: calc(100% + 10px); left: auto; }
.pet-bubble.side-right, .pet-panel.side-right { left: calc(100% + 10px); right: auto; }
.pet-panel {
  z-index: 7;
  width: min(280px, calc(100vw - 24px));
  max-height: min(70vh, 520px);
  overflow: auto;
  padding: 10px;
  user-select: text;
}
.pet-panel[hidden] { display: none; }
.pet-panel button, .pet-panel label { user-select: none; }
.hint, .line, .badge, .note, .panel-row, .state-line { margin: 0; }
.hint, .line, .badge, .note { margin-top: 4px; }
.hint:first-child, .line:first-child, .badge:first-child, .note:first-child { margin-top: 0; }
.tag, .lane, .hint, .state-line, .panel-label {
  color: var(--muted);
  font-size: 11px;
}
.tag, .lane { margin-right: 4px; }
.hint { display: flex; align-items: center; gap: 6px; }
.hint button, .text-btn, .session-btn, .expr-chip, .icon-btn {
  font: inherit;
  cursor: pointer;
  pointer-events: auto;
}
.hint button, .text-btn {
  border: 1px solid #7c6df0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  padding: 2px 8px;
}
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(124, 109, 240, 0.16);
  color: var(--ink);
  font-size: 12px;
}
.note { color: #7c6df0; font-weight: 650; }
.pet-dot {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: rgba(120, 116, 130, 0.55);
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.28);
  pointer-events: none;
  z-index: 5;
}
.pet-dot.is-connecting { background: #f5b942; animation: pet-pulse 1s ease-in-out infinite; }
.pet-dot.is-live { background: #3dcc8a; animation: pet-pulse 1.4s ease-in-out infinite; }
.pet-dot.is-speaking {
  background: #e35dcc;
  box-shadow: 0 0 0 2px rgba(124, 109, 240, 0.45);
  animation: pet-pulse 0.7s ease-in-out infinite;
}
@keyframes pet-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.35); opacity: 0.62; }
}
.pet-tools {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 8px);
  transform: translateX(-50%);
  display: flex;
  gap: 4px;
  padding: 4px;
  border-radius: 999px;
  border: 1px solid #7c6df0;
  background: rgba(255, 252, 248, 0.94);
  box-shadow: 0 6px 18px rgba(36, 24, 64, 0.14);
  z-index: 6;
  opacity: 0;
  pointer-events: none;
  transition: opacity .15s ease;
}
.pet-tools.below { bottom: auto; top: calc(100% + 8px); }
.pet-root:hover .pet-tools,
.pet-root:focus-within .pet-tools,
.pet-root.tools-pinned .pet-tools {
  opacity: 1;
  pointer-events: auto;
}
.icon-btn {
  width: 32px;
  height: 28px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: #241b32;
  font-size: 14px;
}
.icon-btn:hover, .icon-btn:focus-visible { background: rgba(124, 109, 240, 0.22); }
.panel-head, .check, .slider-row, .session-btn, .expr-chip {
  display: flex;
  align-items: center;
}
.panel-head { justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.panel-head strong { font-size: 14px; }
.state-line { overflow-wrap: anywhere; margin-bottom: 4px; }
.session-list { display: flex; flex-direction: column; gap: 4px; margin: 6px 0; }
.session-btn {
  width: 100%;
  text-align: left;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: rgba(124, 109, 240, 0.08);
  color: inherit;
  padding: 4px 6px;
}
.session-btn span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-btn[aria-pressed="true"] { border-color: #7c6df0; }
.slider-row, .check { gap: 8px; margin: 8px 0; }
.slider-row input { flex: 1; accent-color: #7c6df0; }
.expr-strip { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; margin: 6px 0 8px; }
.expr-chip {
  flex-direction: column;
  gap: 2px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  padding: 2px;
  font-size: 10px;
}
.expr-chip img { width: 100%; height: 36px; object-fit: contain; pointer-events: none; }
.expr-chip[aria-pressed="true"] { border-color: #7c6df0; }
.actions { display: flex; gap: 6px; }
.actions .text-btn { flex: 1; padding: 6px 8px; }
@media (prefers-color-scheme: dark) {
  .pet-bubble, .pet-panel {
    --card: rgba(18, 16, 28, 0.84);
    --ink: #f6f1ea;
    --muted: #b7adc8;
  }
  .pet-tools { background: rgba(20, 16, 32, 0.88); }
  .icon-btn { color: #f6f1ea; }
  .session-btn { background: rgba(124, 109, 240, 0.2); }
}
@media (prefers-contrast: more) {
  .pet-bubble, .pet-panel, .pet-tools {
    background: Canvas;
    color: CanvasText;
    border: 2px solid #7c6df0;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
  .tag, .lane, .hint, .state-line, .panel-label { color: CanvasText; }
}
@media (hover: none) {
  .pet-root.tools-pinned .pet-tools { opacity: 1; pointer-events: auto; }
}
@media (prefers-reduced-motion: reduce) {
  .pet-dot { animation: none; }
  .pet-bubble { transition: none; }
}
`;

interface PetPrefs {
  anchor: SavedAnchorPos | null;
  sizePx: number;
  mirrorOnLeft: boolean;
  showBubble: boolean;
  rightGap: number;
  headphoneHintDismissed: boolean;
}

interface DragGesture {
  pointerId: number;
  startX: number;
  startY: number;
  origLeft: number;
  origTop: number;
  moved: boolean;
  active: boolean;
}

interface SessionRow {
  id: string;
  title: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSprite(value: string): value is SpriteName {
  return (SPRITE_NAMES as readonly string[]).includes(value);
}

function isHoldEmotion(value: string): value is HoldEmotion {
  return (HOLD_EMOTIONS as readonly string[]).includes(value);
}

function spriteUrl(name: SpriteName): string {
  return `/dsh-voice/assets/${name}.webp`;
}

function voiceSocketUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/dsh-voice/ws`;
}

function readViewport(): { w: number; h: number } {
  return { w: window.innerWidth, h: window.innerHeight };
}

function defaultPrefs(): PetPrefs {
  return {
    anchor: null,
    sizePx: DEFAULT_SIZE_PX,
    mirrorOnLeft: false,
    showBubble: true,
    rightGap: DEFAULT_RIGHT_GAP,
    headphoneHintDismissed: false,
  };
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

function loadPrefs(): PetPrefs {
  const prefs = defaultPrefs();
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw === null || raw === '') return prefs;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return prefs;
    prefs.anchor = readAnchor(parsed['anchor']);
    prefs.sizePx = readSize(parsed['sizePx']);
    prefs.mirrorOnLeft = parsed['mirrorOnLeft'] === true;
    prefs.showBubble = parsed['showBubble'] !== false;
    prefs.rightGap = readGap(parsed['rightGap']);
    prefs.headphoneHintDismissed = parsed['headphoneHintDismissed'] === true;
  } catch {
    return defaultPrefs();
  }
  return prefs;
}

function savePrefs(prefs: PetPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      anchor: prefs.anchor,
      sizePx: prefs.sizePx,
      mirrorOnLeft: prefs.mirrorOnLeft,
      showBubble: prefs.showBubble,
      rightGap: prefs.rightGap,
      headphoneHintDismissed: prefs.headphoneHintDismissed,
    }));
  } catch {
    // 隐私模式拒写时，这一会话里的位置仍然留在内存里。
  }
}

function laneLabel(path: ReplyPath | undefined): string {
  if (path === 'dsh') return 'L2';
  if (path === 'omni' || path === 'fast') return 'L1';
  return '';
}

function readSession(value: unknown): SessionRow | null {
  if (!isRecord(value)) return null;
  const id = typeof value['sessionId'] === 'string'
    ? value['sessionId']
    : typeof value['id'] === 'string'
      ? value['id']
      : '';
  if (id === '') return null;
  const display = typeof value['displayTitle'] === 'string' ? value['displayTitle'] : '';
  const title = display !== ''
    ? display
    : typeof value['title'] === 'string' && value['title'] !== ''
      ? value['title']
      : id;
  return { id, title };
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

function iconButton(glyph: string, label: string): HTMLButtonElement {
  const button = element('button', 'icon-btn');
  button.type = 'button';
  button.textContent = glyph;
  button.title = label;
  button.setAttribute('aria-label', label);
  return button;
}

function mountFlagged(): boolean {
  const flags = window as unknown as Record<string, unknown>;
  return flags[MOUNT_KEY] === true;
}

function markMounted(): void {
  const flags = window as unknown as Record<string, unknown>;
  flags[MOUNT_KEY] = true;
}

function installHostGuard(): void {
  if (document.getElementById(GUARD_STYLE_ID) !== null) return;
  const style = element('style');
  style.id = GUARD_STYLE_ID;
  style.textContent = HOST_GUARD_CSS;
  (document.head ?? document.documentElement).appendChild(style);
}

/** 已经挂上过就什么都不做。脚本被注入两次也不能叠两只。 */
export function mountVoicePetWidget(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (mountFlagged()) return;
  markMounted();
  if (document.body !== null) {
    mountNow();
    return;
  }
  document.addEventListener('DOMContentLoaded', () => {
    if (document.body === null) return;
    mountNow();
  }, { once: true });
}

function mountNow(): void {
  const prefs = loadPrefs();
  installHostGuard();

  const host = element('div');
  host.id = HOST_ID;
  host.style.transition = 'none';
  host.style.overflow = 'visible';

  const shadow = host.attachShadow({ mode: 'open' });
  const style = element('style');
  style.textContent = WIDGET_CSS;
  const root = element('div', 'pet-root');
  const mirror = element('div', 'pet-mirror');
  const squish = element('div', 'pet-squish');
  const talk = element('div', 'pet-talk');
  const img = element('img', 'pet-img');
  img.alt = 'Gemini-chan';
  img.draggable = false;
  img.tabIndex = 0;
  img.src = spriteUrl('calm');
  img.decoding = 'async';
  squish.style.transition = PRESS_SPRING_TRANSITION;
  squish.style.transform = 'scaleY(1) scaleX(1)';
  talk.style.transform = 'none';

  const bubble = element('div', 'pet-bubble side-left');
  bubble.setAttribute('role', 'status');
  bubble.setAttribute('aria-live', 'polite');
  const hint = element('div', 'hint');
  const hintText = element('span');
  hintText.textContent = '建议佩戴耳机以获得最佳打断体验';
  const hintDismiss = element('button');
  hintDismiss.type = 'button';
  hintDismiss.textContent = '知道了';
  hint.append(hintText, hintDismiss);
  const asrLine = element('div', 'line');
  const asrTag = element('span', 'tag');
  asrTag.textContent = '你：';
  const asrBody = element('span');
  asrLine.append(asrTag, asrBody);
  const replyLine = element('div', 'line');
  const replyLane = element('span', 'lane');
  const replyBody = element('span');
  replyLine.append(replyLane, replyBody);
  const badge = element('div', 'badge');
  badge.textContent = '⚡ 已交由 L2 会话处理';
  const note = element('div', 'note');
  bubble.append(hint, asrLine, replyLine, badge, note);

  const dot = element('span', 'pet-dot is-off');
  dot.setAttribute('role', 'status');
  dot.setAttribute('aria-label', '未连接');

  const tools = element('div', 'pet-tools');
  const micBtn = iconButton('🎙️', '开启通话');
  const muteBtn = iconButton('🔇', '打断静音');
  const gearBtn = iconButton('⚙️', '设置');
  tools.append(micBtn, muteBtn, gearBtn);

  const panel = element('div', 'pet-panel side-left');
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Gemini-chan 设置');
  const panelHead = element('div', 'panel-head');
  const panelTitle = element('strong');
  panelTitle.textContent = 'Gemini-chan';
  const panelClose = element('button', 'text-btn');
  panelClose.type = 'button';
  panelClose.textContent = '关闭';
  panelHead.append(panelTitle, panelClose);
  const pipelineLine = element('div', 'state-line');
  const boundLine = element('div', 'state-line');
  const stateMessage = element('div', 'state-line');
  const sessionList = element('div', 'session-list');
  const createBtn = element('button', 'text-btn');
  createBtn.type = 'button';
  createBtn.textContent = '新建桌宠会话';
  const sliderRow = element('label', 'slider-row');
  const sliderLabel = element('span', 'panel-label');
  sliderLabel.textContent = '大小';
  const sizeInput = element('input');
  sizeInput.type = 'range';
  sizeInput.min = String(SIZE_MIN_PX);
  sizeInput.max = String(SIZE_SLIDER_MAX_PX);
  sizeInput.step = '1';
  sizeInput.value = String(clamp(prefs.sizePx, SIZE_MIN_PX, SIZE_SLIDER_MAX_PX));
  const sizeReadout = element('span', 'panel-label');
  sliderRow.append(sliderLabel, sizeInput, sizeReadout);
  const mirrorLabel = element('label', 'check');
  const mirrorInput = element('input');
  mirrorInput.type = 'checkbox';
  mirrorInput.checked = prefs.mirrorOnLeft;
  const mirrorText = element('span');
  mirrorText.textContent = '贴左镜像立绘';
  mirrorLabel.append(mirrorInput, mirrorText);
  const bubbleLabel = element('label', 'check');
  const bubbleInput = element('input');
  bubbleInput.type = 'checkbox';
  bubbleInput.checked = prefs.showBubble;
  const bubbleText = element('span');
  bubbleText.textContent = '显示字幕气泡';
  bubbleLabel.append(bubbleInput, bubbleText);
  const exprLabel = element('div', 'panel-label');
  exprLabel.textContent = '表情预览';
  const exprStrip = element('div', 'expr-strip');
  const chips = new Map<SpriteName, HTMLButtonElement>();
  for (const name of SPRITE_NAMES) {
    const chip = element('button', 'expr-chip');
    chip.type = 'button';
    chip.title = SPRITE_LABELS[name];
    chip.setAttribute('aria-label', `预览${SPRITE_LABELS[name]}`);
    const mini = element('img');
    mini.alt = '';
    mini.draggable = false;
    mini.src = spriteUrl(name);
    const caption = element('span');
    caption.textContent = SPRITE_LABELS[name];
    chip.append(mini, caption);
    exprStrip.append(chip);
    chips.set(name, chip);
  }
  const resetBtn = element('button', 'text-btn');
  resetBtn.type = 'button';
  resetBtn.textContent = '回到右下角';
  const actions = element('div', 'actions');
  actions.append(createBtn, resetBtn);
  panel.append(
    panelHead,
    pipelineLine,
    boundLine,
    stateMessage,
    sessionList,
    actions,
    sliderRow,
    mirrorLabel,
    bubbleLabel,
    exprLabel,
    exprStrip,
  );

  talk.append(img);
  squish.append(talk);
  mirror.append(squish);
  root.append(mirror, bubble, dot, tools, panel);
  shadow.append(style, root);

  let bubbleSide: BubbleSide = 'left';
  let link: LinkState = 'off';
  let uiPhase: PetUiPhase = 'idle';
  let isSpeaking = false;
  let client: VoiceClient | null = null;
  let drag: DragGesture | null = null;
  let alpha: Uint8ClampedArray | null = null;
  let hitMode: 'rect' | 'alpha' = 'rect';
  let asrText = '';
  let replyText = '';
  let replyPath: ReplyPath | undefined;
  /** 上一条已经收口时，下一次 delta 另起一段，避免叠在旧回复后面。 */
  let replySealed = true;
  let delegated = false;
  let captionsOn = false;
  let noteText = '';
  let bubbleHover = false;
  let settingsOpen = false;
  let sessionBusy = false;
  let boundSessionId: string | null = null;
  let activeEmotion: ActiveEmotion = 'calm';
  let emotionUntil = 0;
  let previewName: SpriteName | null = null;
  let previewUntil = 0;
  let smoothRms = 0;
  let talkPhase = 0;
  let talkStamp = 0;
  let talkRaf = 0;
  let bubbleTimer = 0;
  let noteTimer = 0;
  let spriteTimer = 0;
  let stateTicket = 0;

  const coarsePointer = window.matchMedia('(hover: none), (pointer: coarse)').matches;
  if (coarsePointer) root.classList.add('tools-pinned');

  function applyBoxSize(): void {
    const px = `${prefs.sizePx}px`;
    host.style.width = px;
    host.style.height = px;
    root.style.setProperty('--pet-size', px);
    sizeReadout.textContent = px;
  }

  function applyMirror(): void {
    mirror.style.transform = shouldMirrorArt(bubbleSide, prefs.mirrorOnLeft) ? 'scaleX(-1)' : 'none';
  }

  function placeTools(): void {
    const rect = host.getBoundingClientRect();
    tools.classList.toggle('below', rect.top < 52);
  }

  function placeFloating(node: HTMLElement, side: BubbleSide): void {
    node.classList.toggle('side-left', side === 'left');
    node.classList.toggle('side-right', side === 'right');
    node.style.transform = 'none';
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - margin - rect.width);
    const maxTop = Math.max(margin, window.innerHeight - margin - rect.height);
    const dx = clamp(rect.left, margin, maxLeft) - rect.left;
    const dy = clamp(rect.top, margin, maxTop) - rect.top;
    if (dx !== 0 || dy !== 0) {
      node.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`;
    }
  }

  function layoutFromAnchor(saveHealed: boolean): void {
    const resolved = resolveAnchorPosition(
      prefs.anchor,
      { w: prefs.sizePx, h: prefs.sizePx },
      readViewport(),
      prefs.rightGap,
    );
    host.style.left = `${resolved.left}px`;
    host.style.top = `${resolved.top}px`;
    bubbleSide = resolved.bubbleSide;
    if (resolved.healed) prefs.anchor = resolved.anchor;
    applyMirror();
    placeTools();
    placeFloating(bubble, bubbleSide);
    if (settingsOpen) placeFloating(panel, bubbleSide);
    if (saveHealed && resolved.healed) savePrefs(prefs);
  }

  function setCursor(mode: 'grab' | 'grabbing' | 'none'): void {
    root.classList.toggle('cursor-grab', mode === 'grab');
    root.classList.toggle('cursor-grabbing', mode === 'grabbing');
  }

  function isPetHit(point: { clientX: number; clientY: number }): boolean {
    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (
      point.clientX < rect.left
      || point.clientX > rect.right
      || point.clientY < rect.top
      || point.clientY > rect.bottom
    ) {
      return false;
    }
    if (hitMode !== 'alpha' || alpha === null) return true;
    let x = ((point.clientX - rect.left) / rect.width) * HIT_SIZE;
    const y = ((point.clientY - rect.top) / rect.height) * HIT_SIZE;
    if (shouldMirrorArt(bubbleSide, prefs.mirrorOnLeft)) x = HIT_SIZE - x;
    const ix = Math.min(HIT_SIZE - 1, Math.max(0, Math.floor(x)));
    const iy = Math.min(HIT_SIZE - 1, Math.max(0, Math.floor(y)));
    const pixel = alpha[(iy * HIT_SIZE + ix) * 4 + 3];
    return (pixel ?? 0) > ALPHA_THRESHOLD;
  }

  function currentSprite(): SpriteName {
    const now = Date.now();
    if (isSpeaking) return 'speaking';
    if (uiPhase === 'listening') return 'listening';
    if (previewName !== null && now < previewUntil) return previewName;
    previewName = null;
    if (activeEmotion !== 'calm' && now < emotionUntil) return activeEmotion;
    return 'calm';
  }

  function renderExpression(): void {
    const name = currentSprite();
    const next = spriteUrl(name);
    if (img.getAttribute('src') !== next) img.src = next;
    for (const [sprite, chip] of chips) {
      chip.setAttribute('aria-pressed', sprite === name ? 'true' : 'false');
    }
  }

  function armSpriteTimer(): void {
    window.clearTimeout(spriteTimer);
    const now = Date.now();
    const deadlines = [previewUntil, emotionUntil].filter((time) => time > now);
    if (deadlines.length === 0) return;
    const wait = Math.max(0, Math.min(...deadlines) - now);
    spriteTimer = window.setTimeout(() => { renderExpression(); }, wait + 16);
  }

  function armEmotion(raw: string): void {
    previewName = null;
    activeEmotion = isHoldEmotion(raw) ? raw : 'calm';
    emotionUntil = activeEmotion === 'calm' ? 0 : Date.now() + EMOTION_HOLD_MS;
    armSpriteTimer();
    renderExpression();
  }

  function previewSprite(name: SpriteName): void {
    previewName = name;
    previewUntil = Date.now() + EMOTION_HOLD_MS;
    if (name !== 'speaking' && name !== 'listening') {
      activeEmotion = name === 'calm' ? 'calm' : name;
      emotionUntil = name === 'calm' ? 0 : previewUntil;
    }
    armSpriteTimer();
    renderExpression();
  }

  function renderStatus(): void {
    const mode = link === 'off'
      ? 'off'
      : link === 'connecting'
        ? 'connecting'
        : isSpeaking
          ? 'speaking'
          : 'live';
    dot.className = `pet-dot is-${mode}`;
    const label = mode === 'off'
      ? '未连接'
      : mode === 'connecting'
        ? '正在连接'
        : mode === 'speaking'
          ? '说话中'
          : uiPhase === 'listening'
            ? '聆听中'
            : '通话中';
    dot.setAttribute('aria-label', label);
    const live = link !== 'off';
    const micLabel = live ? '挂断' : '开启通话';
    micBtn.title = micLabel;
    micBtn.setAttribute('aria-label', micLabel);
    micBtn.setAttribute('aria-pressed', live ? 'true' : 'false');
  }

  function renderBubble(): void {
    const captions = prefs.showBubble && captionsOn;
    hint.hidden = prefs.headphoneHintDismissed || !prefs.showBubble;
    const showAsr = captions && asrText.trim() !== '';
    asrLine.hidden = !showAsr;
    asrBody.textContent = asrText;
    const showReply = captions && replyText.trim() !== '';
    replyLine.hidden = !showReply;
    const lane = laneLabel(replyPath);
    replyLane.hidden = lane === '';
    replyLane.textContent = lane;
    replyBody.textContent = replyText;
    badge.hidden = !(captions && delegated);
    note.hidden = noteText === '';
    note.textContent = noteText;
    const visible = !hint.hidden || showAsr || showReply || !badge.hidden || noteText !== '';
    bubble.classList.toggle('show', visible);
    if (visible) placeFloating(bubble, bubbleSide);
  }

  function pokeCaptions(): void {
    captionsOn = true;
    window.clearTimeout(bubbleTimer);
    renderBubble();
    bubbleTimer = window.setTimeout(() => {
      if (bubbleHover) return;
      captionsOn = false;
      delegated = false;
      renderBubble();
    }, BUBBLE_IDLE_MS);
  }

  function flashNote(text: string, durationMs = NOTE_MS): void {
    noteText = text;
    window.clearTimeout(noteTimer);
    renderBubble();
    noteTimer = window.setTimeout(() => {
      noteText = '';
      renderBubble();
    }, durationMs);
  }

  function stopTalk(): void {
    isSpeaking = false;
    if (talkRaf !== 0) cancelAnimationFrame(talkRaf);
    talkRaf = 0;
    smoothRms = 0;
    talkStamp = 0;
    talk.style.transition = 'transform 0.18s ease-out';
    talk.style.transform = 'none';
  }

  function tickTalk(now: number): void {
    if (!isSpeaking) return;
    const dt = talkStamp === 0 ? 16 : Math.min(48, now - talkStamp);
    talkStamp = now;
    const rms = client?.getOutputLevel() ?? 0;
    const follow = rms > smoothRms ? 0.62 : 0.16;
    smoothRms += (rms - smoothRms) * follow;
    talkPhase += dt * 0.006;
    const tiltDeg = clamp(Math.sin(talkPhase) * (0.6 + smoothRms * 2.1), -2.8, 2.8);
    const scaleY = 1 + smoothRms * 0.048;
    const scaleX = 1 - smoothRms * 0.02;
    const liftY = -smoothRms * 3.2;
    talk.style.transition = 'none';
    talk.style.transform = `translateY(${liftY.toFixed(2)}px) rotate(${tiltDeg.toFixed(2)}deg) scaleX(${scaleX.toFixed(4)}) scaleY(${scaleY.toFixed(4)})`;
    if (!isSpeaking) return;
    talkRaf = requestAnimationFrame(tickTalk);
  }

  function setSpeaking(active: boolean): void {
    if (active === isSpeaking) {
      renderStatus();
      return;
    }
    if (active) {
      isSpeaking = true;
      if (talkRaf === 0) {
        talk.style.transition = 'none';
        talkStamp = 0;
        talkRaf = requestAnimationFrame(tickTalk);
      }
    } else {
      stopTalk();
    }
    renderExpression();
    renderStatus();
  }

  function applyUi(event: PetUiEvent): void {
    switch (event.type) {
      case 'phase':
        uiPhase = event.phase;
        renderExpression();
        renderStatus();
        return;
      case 'asr':
        delegated = false;
        asrText = event.text;
        pokeCaptions();
        return;
      case 'asr.replace': {
        const next = event.text.trim();
        if (next === '') return;
        if (event.previous === undefined || asrText.trim() === event.previous.trim()) {
          asrText = next;
          pokeCaptions();
        }
        return;
      }
      case 'reply.delta':
        replyText = replySealed ? event.delta : replyText + event.delta;
        replySealed = false;
        replyPath = event.path;
        pokeCaptions();
        return;
      case 'reply.final':
        replyText = event.text;
        replyPath = event.path;
        replySealed = true;
        armEmotion(event.emotion);
        pokeCaptions();
        return;
      case 'announce':
        replyText = event.text;
        replyPath = undefined;
        replySealed = true;
        armEmotion(event.emotion);
        pokeCaptions();
        return;
      case 'delegated':
        delegated = true;
        pokeCaptions();
        return;
      default: {
        const unreachable: never = event;
        void unreachable;
      }
    }
  }

  function handleClientEvent(event: VoiceClientEvent): void {
    switch (event.type) {
      case 'open':
      case 'ready':
        link = 'live';
        renderStatus();
        return;
      case 'speaking':
        setSpeaking(event.active);
        return;
      case 'ui':
        applyUi(event.event);
        return;
      case 'error':
        if (event.message !== '') flashNote(event.message);
        return;
      case 'close':
        link = 'off';
        uiPhase = 'idle';
        setSpeaking(false);
        if (event.code === 4503 || (event.code !== 1000 && event.reason !== '')) {
          armEmotion('worried');
          flashNote(event.reason !== '' ? event.reason : '语音后端未就绪，请检查 ~/.dsh/.env 凭据', 4500);
        }
        renderExpression();
        renderStatus();
        return;
      case 'control':
      case 'call':
        return;
      default: {
        const unreachable: never = event;
        void unreachable;
      }
    }
  }

  function startVoice(): void {
    if (link === 'connecting') return;
    client?.close();
    const next = createVoiceClient({
      url: voiceSocketUrl(),
      deviceId: 'gemini-chan',
      onEvent: (event) => {
        if (client !== next) return;
        handleClientEvent(event);
      },
    });
    client = next;
    link = 'connecting';
    renderStatus();
    // start() 必须在这次点击的调用栈里进入，AudioContext.resume 才算用户手势。
    void next.start().catch((error: unknown) => {
      if (client !== next) return;
      link = 'off';
      stopTalk();
      uiPhase = 'idle';
      const message = error instanceof Error ? error.message : '语音连接失败';
      flashNote(message);
      renderExpression();
      renderStatus();
    });
  }

  function stopVoice(): void {
    client?.close();
    client = null;
    link = 'off';
    uiPhase = 'idle';
    setSpeaking(false);
    renderExpression();
    renderStatus();
  }

  function interruptVoice(): void {
    client?.interrupt();
    if (isSpeaking) flashNote('已打断');
  }

  function handlePetClick(): void {
    img.focus({ preventScroll: true });
    if (link === 'off' && client?.active !== true) {
      startVoice();
      return;
    }
    if (isSpeaking) {
      interruptVoice();
      return;
    }
    stopVoice();
  }

  function detachDrag(): void {
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', onPointerCancel, true);
  }

  function finishDrag(event: PointerEvent, cancelled: boolean): void {
    if (drag === null || !drag.active || event.pointerId !== drag.pointerId) return;
    const current = drag;
    drag = null;
    detachDrag();
    try {
      if (img.hasPointerCapture(event.pointerId)) img.releasePointerCapture(event.pointerId);
    } catch {
      // 手势结束时捕获可能已经卸掉。
    }
    squish.style.transform = 'scaleY(1) scaleX(1)';
    setCursor(isPetHit(event) ? 'grab' : 'none');
    const revert = shouldRevertDrag({
      cancelled,
      clientX: event.clientX,
      clientY: event.clientY,
      moved: current.moved,
    });
    if (revert || !current.moved) {
      host.style.transition = 'none';
      host.style.left = `${current.origLeft}px`;
      host.style.top = `${current.origTop}px`;
      window.requestAnimationFrame(() => {
        host.style.transition = HOST_MOVE;
      });
      if (!revert && !cancelled) handlePetClick();
      return;
    }
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    const view = readViewport();
    const left = clamp(current.origLeft + dx, 0, Math.max(0, view.w - prefs.sizePx));
    const top = clamp(current.origTop + dy, 0, Math.max(0, view.h - prefs.sizePx));
    const drop = anchorFromDrop(
      left,
      top,
      { w: prefs.sizePx, h: prefs.sizePx },
      view,
      DEFAULT_SNAP_CONFIG,
      prefs.rightGap,
    );
    host.style.transition = 'none';
    void host.offsetWidth;
    host.style.transition = HOST_MOVE;
    host.style.left = `${drop.left}px`;
    host.style.top = `${drop.top}px`;
    prefs.anchor = drop.anchor;
    bubbleSide = drop.bubbleSide;
    applyMirror();
    savePrefs(prefs);
    placeTools();
    placeFloating(bubble, bubbleSide);
    if (settingsOpen) placeFloating(panel, bubbleSide);
  }

  function onPointerMove(event: PointerEvent): void {
    if (drag === null || !drag.active || event.pointerId !== drag.pointerId) return;
    if (event.pointerType === 'mouse' && event.buttons === 0) {
      finishDrag(event, false);
      return;
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (dx * dx + dy * dy >= CLICK_DISTANCE_SQ) drag.moved = true;
    if (!drag.moved) return;
    const view = readViewport();
    const left = clamp(drag.origLeft + dx, 0, Math.max(0, view.w - prefs.sizePx));
    const top = clamp(drag.origTop + dy, 0, Math.max(0, view.h - prefs.sizePx));
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    placeTools();
  }

  function onPointerUp(event: PointerEvent): void {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    if (isPetHit(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
    finishDrag(event, false);
  }

  function onPointerCancel(event: PointerEvent): void {
    finishDrag(event, true);
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !event.isPrimary) return;
    if (!isPetHit(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = host.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origLeft: rect.left,
      origTop: rect.top,
      moved: false,
      active: true,
    };
    host.style.transition = 'none';
    squish.style.transform = PRESS_SQUISH_TRANSFORM;
    setCursor('grabbing');
    try {
      img.setPointerCapture(event.pointerId);
    } catch {
      // 捕获失败时仍靠 window 上的指针监听。
    }
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerCancel, true);
  }

  function syncSessionButtons(): void {
    createBtn.disabled = sessionBusy;
    for (const button of sessionList.querySelectorAll('button')) {
      button.disabled = sessionBusy;
    }
  }

  function renderSessions(rows: readonly SessionRow[]): void {
    sessionList.replaceChildren();
    if (rows.length === 0) {
      const empty = element('div', 'state-line');
      empty.textContent = '没有会话';
      sessionList.append(empty);
      return;
    }
    for (const row of rows) {
      const button = element('button', 'session-btn');
      button.type = 'button';
      button.title = row.id;
      button.setAttribute('aria-pressed', row.id === boundSessionId ? 'true' : 'false');
      const title = element('span');
      title.textContent = row.title;
      button.append(title);
      button.addEventListener('click', () => {
        void selectSession({ sessionId: row.id });
      });
      sessionList.append(button);
    }
    syncSessionButtons();
  }

  function renderState(payload: unknown): void {
    if (!isRecord(payload)) {
      stateMessage.textContent = '读不到会话状态';
      return;
    }
    const mode = typeof payload['pipelineMode'] === 'string' ? payload['pipelineMode'] : '';
    pipelineLine.textContent = mode === '' ? '管线：未知' : `管线：${mode}`;
    const bound = payload['boundSessionId'];
    boundSessionId = typeof bound === 'string' && bound !== '' ? bound : null;
    boundLine.textContent = boundSessionId === null ? '当前会话：未绑定' : `当前会话：${boundSessionId}`;
    const rows: SessionRow[] = [];
    if (Array.isArray(payload['sessions'])) {
      for (const item of payload['sessions']) {
        const row = readSession(item);
        if (row !== null) rows.push(row);
      }
    }
    const voiceReady = payload['voiceReady'];
    const voiceError = typeof payload['voiceError'] === 'string' && payload['voiceError'] !== ''
      ? payload['voiceError']
      : '';
    stateMessage.textContent = voiceReady === false
      ? `语音未就绪：${voiceError || '请检查 ~/.dsh/.env 中的 STT/TTS 凭据'}`
      : '';
    renderSessions(rows);
  }

  async function loadState(): Promise<void> {
    const ticket = ++stateTicket;
    stateMessage.textContent = '正在读取…';
    try {
      const response = await fetch('/dsh-voice/state', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload: unknown = await response.json();
      if (ticket !== stateTicket) return;
      renderState(payload);
    } catch {
      if (ticket !== stateTicket) return;
      stateMessage.textContent = '读不到会话状态';
    }
  }

  async function selectSession(body: { sessionId: string } | { action: 'create' }): Promise<void> {
    if (sessionBusy) return;
    sessionBusy = true;
    syncSessionButtons();
    stateMessage.textContent = '正在切换…';
    try {
      const response = await fetch('/dsh-voice/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload: unknown = await response.json();
      if (isRecord(payload) && payload['ok'] === false) throw new Error('会话切换失败');
      await loadState();
    } catch {
      stateMessage.textContent = '会话切换失败';
    } finally {
      sessionBusy = false;
      syncSessionButtons();
    }
  }

  function openSettings(): void {
    settingsOpen = true;
    panel.hidden = false;
    placeFloating(panel, bubbleSide);
    void loadState();
  }

  function closeSettings(): void {
    settingsOpen = false;
    panel.hidden = true;
  }

  function resetPosition(): void {
    prefs.anchor = null;
    host.style.transition = HOST_MOVE;
    layoutFromAnchor(true);
  }

  function buildHitMap(image: HTMLImageElement): void {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = HIT_SIZE;
      canvas.height = HIT_SIZE;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx === null) {
        hitMode = 'rect';
        alpha = null;
        img.style.clipPath = '';
        return;
      }
      const sourceWidth = image.naturalWidth > 0 ? image.naturalWidth : HIT_SIZE;
      const sourceHeight = image.naturalHeight > 0 ? image.naturalHeight : HIT_SIZE;
      const scale = Math.min(HIT_SIZE / sourceWidth, HIT_SIZE / sourceHeight);
      const dw = sourceWidth * scale;
      const dh = sourceHeight * scale;
      ctx.clearRect(0, 0, HIT_SIZE, HIT_SIZE);
      ctx.drawImage(image, (HIT_SIZE - dw) / 2, (HIT_SIZE - dh) / 2, dw, dh);
      const rgba = ctx.getImageData(0, 0, HIT_SIZE, HIT_SIZE).data;
      if (!hasOpaqueProbePixels(rgba, HIT_SIZE, HIT_SIZE)) {
        hitMode = 'rect';
        alpha = null;
        img.style.clipPath = '';
        return;
      }
      alpha = rgba;
      hitMode = 'alpha';
      const poly = buildAlphaClipPath(rgba, HIT_SIZE, HIT_SIZE);
      img.style.clipPath = poly;
      img.style.setProperty('-webkit-clip-path', poly);
    } catch {
      hitMode = 'rect';
      alpha = null;
      img.style.clipPath = '';
    }
  }

  function preloadSprites(): void {
    for (const name of SPRITE_NAMES) {
      const image = new Image();
      image.decoding = 'async';
      if (name === 'calm') {
        image.addEventListener('load', () => { buildHitMap(image); });
        image.addEventListener('error', () => {
          hitMode = 'rect';
          alpha = null;
          img.style.clipPath = '';
        });
      }
      image.src = spriteUrl(name);
      if (name === 'calm' && image.complete && image.naturalWidth > 0) buildHitMap(image);
    }
  }

  applyBoxSize();
  pipelineLine.textContent = '管线：…';
  boundLine.textContent = '当前会话：…';
  document.body.appendChild(host);
  layoutFromAnchor(true);
  renderBubble();
  renderStatus();
  renderExpression();
  preloadSprites();
  window.requestAnimationFrame(() => {
    host.style.transition = HOST_MOVE;
  });

  img.addEventListener('pointerdown', onPointerDown);
  img.addEventListener('pointermove', (event) => {
    if (drag?.active === true) return;
    setCursor(isPetHit(event) ? 'grab' : 'none');
  });
  img.addEventListener('pointerleave', () => {
    if (drag?.active === true) return;
    setCursor('none');
  });
  img.addEventListener('dragstart', (event) => { event.preventDefault(); });
  img.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (settingsOpen) closeSettings();
    else openSettings();
  });
  img.addEventListener('keydown', (event) => {
    if (event.key !== ' ' && event.code !== 'Space') return;
    if (event.repeat || link === 'off') return;
    event.preventDefault();
    interruptVoice();
  });
  img.addEventListener('touchstart', (event) => {
    event.preventDefault();
  }, { passive: false });

  bubble.addEventListener('mouseenter', () => { bubbleHover = true; });
  bubble.addEventListener('mouseleave', () => {
    bubbleHover = false;
    window.clearTimeout(bubbleTimer);
    bubbleTimer = window.setTimeout(() => {
      if (bubbleHover) return;
      captionsOn = false;
      delegated = false;
      renderBubble();
    }, BUBBLE_IDLE_MS);
  });
  hintDismiss.addEventListener('click', (event) => {
    event.stopPropagation();
    prefs.headphoneHintDismissed = true;
    savePrefs(prefs);
    renderBubble();
  });
  micBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (link === 'off') startVoice();
    else stopVoice();
  });
  muteBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    interruptVoice();
  });
  gearBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (settingsOpen) closeSettings();
    else openSettings();
  });
  panelClose.addEventListener('click', () => { closeSettings(); });
  createBtn.addEventListener('click', () => { void selectSession({ action: 'create' }); });
  resetBtn.addEventListener('click', () => { resetPosition(); });
  sizeInput.addEventListener('input', () => {
    const next = Number(sizeInput.value);
    if (!Number.isFinite(next)) return;
    prefs.sizePx = clamp(Math.round(next), SIZE_MIN_PX, SIZE_SLIDER_MAX_PX);
    applyBoxSize();
    const previous = host.style.transition;
    host.style.transition = 'none';
    layoutFromAnchor(false);
    host.style.transition = previous;
    savePrefs(prefs);
  });
  mirrorInput.addEventListener('change', () => {
    prefs.mirrorOnLeft = mirrorInput.checked;
    applyMirror();
    savePrefs(prefs);
  });
  bubbleInput.addEventListener('change', () => {
    prefs.showBubble = bubbleInput.checked;
    renderBubble();
    savePrefs(prefs);
  });
  for (const [name, chip] of chips) {
    chip.addEventListener('click', () => { previewSprite(name); });
  }

  window.addEventListener('resize', () => {
    if (drag?.active === true) return;
    const previous = host.style.transition;
    host.style.transition = 'none';
    layoutFromAnchor(true);
    host.style.transition = previous;
  });
  window.addEventListener('pointerdown', (event) => {
    if (!settingsOpen) return;
    const path = event.composedPath();
    if (path.includes(panel) || path.includes(gearBtn) || path.includes(img)) return;
    closeSettings();
  }, true);
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !settingsOpen) return;
    if (!event.composedPath().includes(host)) return;
    closeSettings();
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  mountVoicePetWidget();
}
