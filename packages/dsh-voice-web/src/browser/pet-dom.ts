/**
 * 搭出 Shadow DOM 外壳并交出节点表（对齐 dsh 原生 Popover 与线性 SVG 图标）。
 *
 * 不绑网络、不定时器、不听指针。全部图标使用原生 SVG DOM 创建，不拼 innerHTML。
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

const SVG_NS = 'http://www.w3.org/2000/svg';

type SvgPart = readonly [tag: 'path' | 'rect' | 'line' | 'circle' | 'polyline', attrs: Record<string, string>];

function createSvgIcon(
  doc: Document,
  size: number,
  strokeWidth: string,
  parts: readonly SvgPart[],
): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', strokeWidth);
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of parts) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      node.setAttribute(key, value);
    }
    svg.append(node);
  }
  return svg;
}

const MIC_PARTS: readonly SvgPart[] = [
  ['rect', { x: '9', y: '2.5', width: '6', height: '11', rx: '3' }],
  ['path', { d: 'M5.5 10.5a6.5 6.5 0 0 0 13 0' }],
  ['path', { d: 'M12 17v4' }],
];

const MUTE_PARTS: readonly SvgPart[] = [
  ['path', { d: 'M11 5L6 9H3v6h3l5 4V5z' }],
  ['line', { x1: '22', y1: '9', x2: '16', y2: '15' }],
  ['line', { x1: '16', y1: '9', x2: '22', y2: '15' }],
];

const GEAR_PARTS: readonly SvgPart[] = [
  ['circle', { cx: '12', cy: '12', r: '3' }],
  [
    'path',
    {
      d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06'
        + 'a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09'
        + 'a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83'
        + 'l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09'
        + 'a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83'
        + 'l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09'
        + 'a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83'
        + 'l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09'
        + 'a1.65 1.65 0 0 0-1.51 1z',
    },
  ],
];

const CLOSE_PARTS: readonly SvgPart[] = [
  ['line', { x1: '18', y1: '6', x2: '6', y2: '18' }],
  ['line', { x1: '6', y1: '6', x2: '18', y2: '18' }],
];

const PLUS_PARTS: readonly SvgPart[] = [
  ['line', { x1: '12', y1: '5', x2: '12', y2: '19' }],
  ['line', { x1: '5', y1: '12', x2: '19', y2: '12' }],
];

const CHECK_PARTS: readonly SvgPart[] = [
  ['polyline', { points: '20 6 9 17 4 12' }],
];

const CHEVRON_PARTS: readonly SvgPart[] = [
  ['polyline', { points: '9 18 15 12 9 6' }],
];

const SPARK_PARTS: readonly SvgPart[] = [
  ['path', { d: 'M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3z' }],
];

const CORNER_PARTS: readonly SvgPart[] = [
  ['polyline', { points: '15 10 20 15 15 20' }],
  ['path', { d: 'M4 4v7a4 4 0 0 0 4 4h12' }],
];

/** 供会话行复用：创建选中态单色勾选 SVG。 */
export function createCheckIcon(doc: Document): SVGSVGElement {
  return createSvgIcon(doc, 13, '2.1', CHECK_PARTS);
}

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
  readonly statusBar: HTMLDivElement;
  readonly statusText: HTMLSpanElement;
  readonly tools: HTMLDivElement;
  readonly micBtn: HTMLButtonElement;
  readonly muteBtn: HTMLButtonElement;
  readonly gearBtn: HTMLButtonElement;
  readonly panel: HTMLDivElement;
  readonly panelClose: HTMLButtonElement;
  readonly pipelineTag: HTMLSpanElement;
  readonly boundId: HTMLSpanElement;
  readonly stateMessage: HTMLDivElement;
  readonly sessionList: HTMLDivElement;
  readonly createBtn: HTMLButtonElement;
  readonly sizeInput: HTMLInputElement;
  readonly sizeReadout: HTMLSpanElement;
  readonly mirrorInput: HTMLInputElement;
  readonly bubbleInput: HTMLInputElement;
  readonly exprDetails: HTMLDetailsElement;
  readonly exprCurrent: HTMLSpanElement;
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

function iconButton(
  doc: Document,
  icon: SVGSVGElement,
  label: string,
): HTMLButtonElement {
  const button = element(doc, 'button', 'icon-btn');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(icon);
  return button;
}

function createSwitchRow(
  doc: Document,
  labelText: string,
  checked: boolean,
): { readonly row: HTMLLabelElement; readonly input: HTMLInputElement } {
  const row = element(doc, 'label', 'setting-row');
  const title = element(doc, 'span', 'row-title');
  title.textContent = labelText;
  const wrap = element(doc, 'span', 'switch');
  const input = element(doc, 'input');
  input.type = 'checkbox';
  input.checked = checked;
  const track = element(doc, 'span', 'switch-track');
  wrap.append(input, track);
  row.append(title, wrap);
  return { row, input };
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

  // 贴底微缩状态胶囊（待机隐藏，连接 / 倾听 / 播报时轻显）
  const statusBar = element(doc, 'div', 'pet-status is-off');
  statusBar.setAttribute('role', 'status');
  statusBar.setAttribute('aria-label', '未连接');
  const statusDot = element(doc, 'span', 'pet-status-dot');
  const statusText = element(doc, 'span', 'pet-status-text');
  statusBar.append(statusDot, statusText);

  // 实时字幕气泡
  const bubble = element(doc, 'div', 'pet-bubble side-left');
  bubble.setAttribute('role', 'status');
  bubble.setAttribute('aria-live', 'polite');

  const asrLine = element(doc, 'div', 'asr-row');
  const asrBody = element(doc, 'span');
  asrLine.append(asrBody);

  const replyLine = element(doc, 'div', 'reply-row');
  const replyLane = element(doc, 'span', 'lane-pill');
  const replyBody = element(doc, 'span');
  replyLine.append(replyLane, replyBody);

  const badge = element(doc, 'div', 'delegate-badge');
  const badgeText = element(doc, 'span');
  badgeText.textContent = '已交由 L2 会话处理';
  badge.append(createSvgIcon(doc, 12, '1.9', SPARK_PARTS), badgeText);

  const note = element(doc, 'div', 'note-row');

  const hint = element(doc, 'div', 'hint-row');
  const hintText = element(doc, 'span');
  hintText.textContent = '建议佩戴耳机以获得最佳打断体验';
  const hintDismiss = element(doc, 'button', 'hint-dismiss');
  hintDismiss.type = 'button';
  hintDismiss.textContent = '知道了';
  hint.append(hintText, hintDismiss);

  bubble.append(asrLine, replyLine, badge, note, hint);

  // 悬浮工具栏（单色线性 SVG + 透明桥接垫片）
  const tools = element(doc, 'div', 'pet-tools');
  const micBtn = iconButton(doc, createSvgIcon(doc, 15, '1.8', MIC_PARTS), '开启通话');
  const muteBtn = iconButton(doc, createSvgIcon(doc, 15, '1.8', MUTE_PARTS), '打断静音');
  muteBtn.disabled = true;
  const gearBtn = iconButton(doc, createSvgIcon(doc, 15, '1.75', GEAR_PARTS), '设置');
  gearBtn.setAttribute('aria-pressed', 'false');
  tools.append(micBtn, muteBtn, gearBtn);

  // 设置浮窗（272px · 固定头 / 可滚体 / 固定尾）
  const panel = element(doc, 'div', 'pet-panel side-left');
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Gemini-chan 设置');

  const panelHead = element(doc, 'div', 'panel-head');
  const titleGroup = element(doc, 'div', 'panel-title-group');
  const panelTitle = element(doc, 'strong');
  panelTitle.textContent = 'Gemini-chan';
  const pipelineTag = element(doc, 'span', 'mode-tag');
  pipelineTag.textContent = '…';
  titleGroup.append(panelTitle, pipelineTag);
  const panelClose = iconButton(doc, createSvgIcon(doc, 14, '1.9', CLOSE_PARTS), '关闭');
  panelHead.append(titleGroup, panelClose);

  const panelBody = element(doc, 'div', 'panel-body');

  // 区块 1：会话绑定
  const sessionSection = element(doc, 'div', 'panel-section');
  const sessionHead = element(doc, 'div', 'section-head');
  const sessionLabel = element(doc, 'span', 'section-label');
  sessionLabel.textContent = '会话';
  const createBtn = element(doc, 'button', 'ghost-action');
  createBtn.type = 'button';
  const createText = element(doc, 'span');
  createText.textContent = '新建';
  createBtn.append(createSvgIcon(doc, 13, '2', PLUS_PARTS), createText);
  sessionHead.append(sessionLabel, createBtn);

  const stateMessage = element(doc, 'div', 'state-alert');
  stateMessage.hidden = true;
  const sessionList = element(doc, 'div', 'session-list');
  sessionSection.append(sessionHead, stateMessage, sessionList);

  // 区块 2：外观
  const appearSection = element(doc, 'div', 'panel-section');
  const appearLabel = element(doc, 'span', 'section-label');
  appearLabel.textContent = '外观';

  const sizeRow = element(doc, 'div', 'setting-row');
  const sizeTitle = element(doc, 'span', 'row-title');
  sizeTitle.textContent = '大小';
  const sizeControl = element(doc, 'div', 'size-control');
  const sizeInput = element(doc, 'input', 'range-input');
  sizeInput.type = 'range';
  sizeInput.min = String(SIZE_MIN_PX);
  sizeInput.max = String(SIZE_SLIDER_MAX_PX);
  sizeInput.step = '1';
  sizeInput.value = String(clamp(prefs.sizePx, SIZE_MIN_PX, SIZE_SLIDER_MAX_PX));
  sizeInput.setAttribute('aria-label', '挂件大小');
  const sizeReadout = element(doc, 'span', 'size-readout');
  sizeControl.append(sizeInput, sizeReadout);
  sizeRow.append(sizeTitle, sizeControl);

  const bubbleSwitch = createSwitchRow(doc, '显示字幕气泡', prefs.showBubble);
  const mirrorSwitch = createSwitchRow(doc, '贴左镜像立绘', prefs.mirrorOnLeft);
  appearSection.append(appearLabel, sizeRow, bubbleSwitch.row, mirrorSwitch.row);

  // 区块 3：默认折叠的表情预览
  const exprSection = element(doc, 'div', 'panel-section');
  const exprDetails = element(doc, 'details', 'expr-details');
  const exprSummary = element(doc, 'summary');
  const exprTitle = element(doc, 'span');
  exprTitle.textContent = '表情预览';
  const exprSummaryRight = element(doc, 'span', 'expr-summary-right');
  const exprCurrent = element(doc, 'span');
  exprCurrent.textContent = SPRITE_LABELS.calm;
  const exprChevron = element(doc, 'span', 'expr-chevron');
  exprChevron.append(createSvgIcon(doc, 13, '1.9', CHEVRON_PARTS));
  exprSummaryRight.append(exprCurrent, exprChevron);
  exprSummary.append(exprTitle, exprSummaryRight);

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
  exprDetails.append(exprSummary, exprStrip);
  exprSection.append(exprDetails);

  panelBody.append(sessionSection, appearSection, exprSection);

  // 固定底栏：绑定会话 ID + 重置位置
  const panelFoot = element(doc, 'div', 'panel-foot');
  const boundId = element(doc, 'span', 'bound-id');
  boundId.textContent = '…';
  const resetBtn = element(doc, 'button', 'ghost-action');
  resetBtn.type = 'button';
  const resetText = element(doc, 'span');
  resetText.textContent = '回到右下角';
  resetBtn.append(createSvgIcon(doc, 12, '1.9', CORNER_PARTS), resetText);
  panelFoot.append(boundId, resetBtn);

  panel.append(panelHead, panelBody, panelFoot);

  talk.append(img);
  squish.append(talk);
  mirror.append(squish);
  root.append(mirror, statusBar, tools, bubble, panel);
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
    statusBar,
    statusText,
    tools,
    micBtn,
    muteBtn,
    gearBtn,
    panel,
    panelClose,
    pipelineTag,
    boundId,
    stateMessage,
    sessionList,
    createBtn,
    sizeInput,
    sizeReadout,
    mirrorInput: mirrorSwitch.input,
    bubbleInput: bubbleSwitch.input,
    exprDetails,
    exprCurrent,
    chips,
    resetBtn,
  };
}
