/**
 * 搭出 Shadow DOM 外壳并交出节点表。
 *
 * 不绑网络、不定时器、不听指针。尺寸滑条的初值按滑条上限夹，不改 prefs 本身。
 */
import {
  PRESS_SPRING_TRANSITION,
  clamp,
} from './pet-geometry.ts';
import {
  SIZE_MIN_PX,
  SIZE_SLIDER_MAX_PX,
  type PetPrefs,
} from './pet-prefs.ts';
import {
  SPRITE_LABELS,
  SPRITE_NAMES,
  spriteUrl,
  type SpriteName,
} from './pet-sprites.ts';
import { WIDGET_CSS } from './pet-styles.ts';

export const HOST_ID = 'dsh-voice-pet-host';
export const GUARD_STYLE_ID = 'dsh-voice-pet-host-guard';

export interface PetShell {
  readonly host: HTMLDivElement;
  readonly shadow: ShadowRoot;
  readonly style: HTMLStyleElement;
  readonly root: HTMLDivElement;
  readonly mirror: HTMLDivElement;
  readonly squish: HTMLDivElement;
  readonly talk: HTMLDivElement;
  readonly img: HTMLImageElement;
  readonly bubble: HTMLDivElement;
  readonly hint: HTMLDivElement;
  readonly hintDismiss: HTMLButtonElement;
  readonly asrLine: HTMLDivElement;
  readonly asrBody: HTMLSpanElement;
  readonly replyLine: HTMLDivElement;
  readonly replyLane: HTMLSpanElement;
  readonly replyBody: HTMLSpanElement;
  readonly badge: HTMLDivElement;
  readonly note: HTMLDivElement;
  readonly dot: HTMLSpanElement;
  readonly tools: HTMLDivElement;
  readonly micBtn: HTMLButtonElement;
  readonly muteBtn: HTMLButtonElement;
  readonly gearBtn: HTMLButtonElement;
  readonly panel: HTMLDivElement;
  readonly panelClose: HTMLButtonElement;
  readonly pipelineLine: HTMLDivElement;
  readonly boundLine: HTMLDivElement;
  readonly stateMessage: HTMLDivElement;
  readonly sessionList: HTMLDivElement;
  readonly createBtn: HTMLButtonElement;
  readonly sizeInput: HTMLInputElement;
  readonly sizeReadout: HTMLSpanElement;
  readonly mirrorInput: HTMLInputElement;
  readonly bubbleInput: HTMLInputElement;
  readonly chips: ReadonlyMap<SpriteName, HTMLButtonElement>;
  readonly resetBtn: HTMLButtonElement;
}

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

function iconButton(doc: Document, glyph: string, label: string): HTMLButtonElement {
  const button = element(doc, 'button', 'icon-btn');
  button.type = 'button';
  button.textContent = glyph;
  button.title = label;
  button.setAttribute('aria-label', label);
  return button;
}

export function buildPetShell(doc: Document, prefs: PetPrefs): PetShell {
  const host = element(doc, 'div');
  host.id = HOST_ID;
  host.style.transition = 'none';
  host.style.overflow = 'visible';

  const shadow = host.attachShadow({ mode: 'open' });
  const style = element(doc, 'style');
  style.textContent = WIDGET_CSS;
  const root = element(doc, 'div', 'pet-root');
  const mirror = element(doc, 'div', 'pet-mirror');
  const squish = element(doc, 'div', 'pet-squish');
  const talk = element(doc, 'div', 'pet-talk');
  const img = element(doc, 'img', 'pet-img');
  img.alt = 'Gemini-chan';
  img.draggable = false;
  img.tabIndex = 0;
  img.src = spriteUrl('calm');
  img.decoding = 'async';
  squish.style.transition = PRESS_SPRING_TRANSITION;
  squish.style.transform = 'scaleY(1) scaleX(1)';
  talk.style.transform = 'none';

  const bubble = element(doc, 'div', 'pet-bubble side-left');
  bubble.setAttribute('role', 'status');
  bubble.setAttribute('aria-live', 'polite');
  const hint = element(doc, 'div', 'hint');
  const hintText = element(doc, 'span');
  hintText.textContent = '建议佩戴耳机以获得最佳打断体验';
  const hintDismiss = element(doc, 'button');
  hintDismiss.type = 'button';
  hintDismiss.textContent = '知道了';
  hint.append(hintText, hintDismiss);
  const asrLine = element(doc, 'div', 'line');
  const asrTag = element(doc, 'span', 'tag');
  asrTag.textContent = '你：';
  const asrBody = element(doc, 'span');
  asrLine.append(asrTag, asrBody);
  const replyLine = element(doc, 'div', 'line');
  const replyLane = element(doc, 'span', 'lane');
  const replyBody = element(doc, 'span');
  replyLine.append(replyLane, replyBody);
  const badge = element(doc, 'div', 'badge');
  badge.textContent = '⚡ 已交由 L2 会话处理';
  const note = element(doc, 'div', 'note');
  bubble.append(hint, asrLine, replyLine, badge, note);

  const dot = element(doc, 'span', 'pet-dot is-off');
  dot.setAttribute('role', 'status');
  dot.setAttribute('aria-label', '未连接');

  const tools = element(doc, 'div', 'pet-tools');
  const micBtn = iconButton(doc, '🎙️', '开启通话');
  const muteBtn = iconButton(doc, '🔇', '打断静音');
  const gearBtn = iconButton(doc, '⚙️', '设置');
  tools.append(micBtn, muteBtn, gearBtn);

  const panel = element(doc, 'div', 'pet-panel side-left');
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Gemini-chan 设置');
  const panelHead = element(doc, 'div', 'panel-head');
  const panelTitle = element(doc, 'strong');
  panelTitle.textContent = 'Gemini-chan';
  const panelClose = element(doc, 'button', 'text-btn');
  panelClose.type = 'button';
  panelClose.textContent = '关闭';
  panelHead.append(panelTitle, panelClose);
  const pipelineLine = element(doc, 'div', 'state-line');
  const boundLine = element(doc, 'div', 'state-line');
  const stateMessage = element(doc, 'div', 'state-line');
  const sessionList = element(doc, 'div', 'session-list');
  const createBtn = element(doc, 'button', 'text-btn');
  createBtn.type = 'button';
  createBtn.textContent = '新建桌宠会话';
  const sliderRow = element(doc, 'label', 'slider-row');
  const sliderLabel = element(doc, 'span', 'panel-label');
  sliderLabel.textContent = '大小';
  const sizeInput = element(doc, 'input');
  sizeInput.type = 'range';
  sizeInput.min = String(SIZE_MIN_PX);
  sizeInput.max = String(SIZE_SLIDER_MAX_PX);
  sizeInput.step = '1';
  sizeInput.value = String(clamp(prefs.sizePx, SIZE_MIN_PX, SIZE_SLIDER_MAX_PX));
  const sizeReadout = element(doc, 'span', 'panel-label');
  sliderRow.append(sliderLabel, sizeInput, sizeReadout);
  const mirrorLabel = element(doc, 'label', 'check');
  const mirrorInput = element(doc, 'input');
  mirrorInput.type = 'checkbox';
  mirrorInput.checked = prefs.mirrorOnLeft;
  const mirrorText = element(doc, 'span');
  mirrorText.textContent = '贴左镜像立绘';
  mirrorLabel.append(mirrorInput, mirrorText);
  const bubbleLabel = element(doc, 'label', 'check');
  const bubbleInput = element(doc, 'input');
  bubbleInput.type = 'checkbox';
  bubbleInput.checked = prefs.showBubble;
  const bubbleText = element(doc, 'span');
  bubbleText.textContent = '显示字幕气泡';
  bubbleLabel.append(bubbleInput, bubbleText);
  const exprLabel = element(doc, 'div', 'panel-label');
  exprLabel.textContent = '表情预览';
  const exprStrip = element(doc, 'div', 'expr-strip');
  const chips = new Map<SpriteName, HTMLButtonElement>();
  for (const name of SPRITE_NAMES) {
    const chip = element(doc, 'button', 'expr-chip');
    chip.type = 'button';
    chip.title = SPRITE_LABELS[name];
    chip.setAttribute('aria-label', `预览${SPRITE_LABELS[name]}`);
    const mini = element(doc, 'img');
    mini.alt = '';
    mini.draggable = false;
    mini.src = spriteUrl(name);
    const caption = element(doc, 'span');
    caption.textContent = SPRITE_LABELS[name];
    chip.append(mini, caption);
    exprStrip.append(chip);
    chips.set(name, chip);
  }
  const resetBtn = element(doc, 'button', 'text-btn');
  resetBtn.type = 'button';
  resetBtn.textContent = '回到右下角';
  const actions = element(doc, 'div', 'actions');
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

  return {
    host,
    shadow,
    style,
    root,
    mirror,
    squish,
    talk,
    img,
    bubble,
    hint,
    hintDismiss,
    asrLine,
    asrBody,
    replyLine,
    replyLane,
    replyBody,
    badge,
    note,
    dot,
    tools,
    micBtn,
    muteBtn,
    gearBtn,
    panel,
    panelClose,
    pipelineLine,
    boundLine,
    stateMessage,
    sessionList,
    createBtn,
    sizeInput,
    sizeReadout,
    mirrorInput,
    bubbleInput,
    chips,
    resetBtn,
  };
}
