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
import {
  DEFAULT_CASCADE_STT_MODEL,
  DEFAULT_CASCADE_TTS_MODEL,
  DEFAULT_CASCADE_TTS_VOICE,
  DEFAULT_LIVE_ASR_MODEL,
  DEFAULT_LIVE_MODEL,
  DEFAULT_OPENAI_BASE_URL,
  OPTIMIZED_DEFAULT_TIP,
  VOICE_MODES,
  VOICE_MODE_LABELS,
  type VoiceMode,
} from '../voice-overrides.ts';
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

export interface ApiKeyFieldDom {
  readonly row: HTMLDivElement;
  readonly badge: HTMLSpanElement;
  readonly clearBtn: HTMLButtonElement;
  readonly input: HTMLInputElement;
}

export interface ModelPickerDom {
  readonly container: HTMLDivElement;
  readonly fetchBtn: HTMLButtonElement;
  readonly status: HTMLSpanElement;
  readonly tableWrap: HTMLDivElement;
  readonly filterInput: HTMLInputElement;
  readonly list: HTMLDivElement;
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
  readonly configSection: HTMLDivElement;
  readonly configDetails: HTMLDetailsElement;
  readonly configSummaryValue: HTMLSpanElement;
  readonly configTip: HTMLDivElement;
  readonly configTipText: HTMLSpanElement;
  readonly modeBtns: ReadonlyMap<VoiceMode, HTMLButtonElement>;
  readonly defaultPane: HTMLDivElement;
  readonly defaultKeyField: ApiKeyFieldDom;
  readonly livePane: HTMLDivElement;
  readonly liveBaseUrlInput: HTMLInputElement;
  readonly liveKeyField: ApiKeyFieldDom;
  readonly liveModelPicker: ModelPickerDom;
  readonly liveModelInput: HTMLInputElement;
  readonly liveAsrModelInput: HTMLInputElement;
  readonly cascadePane: HTMLDivElement;
  readonly cascadeSttBaseUrlInput: HTMLInputElement;
  readonly cascadeSttKeyField: ApiKeyFieldDom;
  readonly cascadeSttPicker: ModelPickerDom;
  readonly cascadeSttModelInput: HTMLInputElement;
  readonly cascadeTtsReuseInput: HTMLInputElement;
  readonly cascadeTtsEndpointBox: HTMLDivElement;
  readonly cascadeTtsBaseUrlInput: HTMLInputElement;
  readonly cascadeTtsKeyField: ApiKeyFieldDom;
  readonly cascadeTtsPicker: ModelPickerDom;
  readonly cascadeTtsModelInput: HTMLInputElement;
  readonly cascadeTtsVoiceInput: HTMLInputElement;
  readonly configEnvHint: HTMLDivElement;
  readonly configFeedback: HTMLDivElement;
  readonly configResetBtn: HTMLButtonElement;
  readonly configApplyBtn: HTMLButtonElement;
  readonly sizeInput: HTMLInputElement;
  readonly sizeReadout: HTMLSpanElement;
  readonly mirrorInput: HTMLInputElement;
  readonly bubbleInput: HTMLInputElement;
  readonly soundInput: HTMLInputElement;
  readonly retroInput: HTMLInputElement;
  readonly sfxTestBtn: HTMLButtonElement;
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

function createFieldRow(
  doc: Document,
  labelText: string,
  control: HTMLElement,
): HTMLDivElement {
  const field = element(doc, 'div', 'config-field');
  const label = element(doc, 'label', 'config-label');
  label.textContent = labelText;
  field.append(label, control);
  return field;
}

function createTextInput(
  doc: Document,
  ariaLabel: string,
  placeholder: string,
  maxLength = 128,
): HTMLInputElement {
  const input = element(doc, 'input', 'config-input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.maxLength = maxLength;
  input.placeholder = placeholder;
  input.setAttribute('aria-label', ariaLabel);
  return input;
}

function createApiKeyField(
  doc: Document,
  labelText: string,
  placeholder: string,
): ApiKeyFieldDom {
  const row = element(doc, 'div', 'config-field');
  const head = element(doc, 'div', 'config-field-head');
  const label = element(doc, 'label', 'config-label');
  label.textContent = labelText;
  const meta = element(doc, 'span', 'key-meta');
  const badge = element(doc, 'span', 'key-badge');
  badge.textContent = '未配置';
  const clearBtn = element(doc, 'button', 'key-clear-btn');
  clearBtn.type = 'button';
  clearBtn.textContent = '清除';
  clearBtn.hidden = true;
  meta.append(badge, clearBtn);
  head.append(label, meta);

  const input = element(doc, 'input', 'config-input');
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.maxLength = 512;
  input.placeholder = placeholder;
  input.setAttribute('aria-label', labelText);
  row.append(head, input);
  return { row, badge, clearBtn, input };
}

function createModelPicker(doc: Document, fetchLabel: string): ModelPickerDom {
  const container = element(doc, 'div', 'model-picker');
  const bar = element(doc, 'div', 'model-fetch-bar');
  const fetchBtn = element(doc, 'button', 'fetch-btn');
  fetchBtn.type = 'button';
  fetchBtn.textContent = fetchLabel;
  const status = element(doc, 'span', 'model-fetch-status');
  bar.append(fetchBtn, status);

  const tableWrap = element(doc, 'div', 'model-table-wrap');
  tableWrap.hidden = true;
  const filterInput = element(doc, 'input', 'model-filter');
  filterInput.type = 'text';
  filterInput.autocomplete = 'off';
  filterInput.spellcheck = false;
  filterInput.placeholder = '筛选可用模型…';
  filterInput.setAttribute('aria-label', '筛选可用模型');
  filterInput.hidden = true;
  const list = element(doc, 'div', 'model-table-list');
  tableWrap.append(filterInput, list);

  container.append(bar, tableWrap);
  return { container, fetchBtn, status, tableWrap, filterInput, list };
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

  // 区块 2：语音引擎（默认优化 / Live / 级联；填 Base URL + API Key 拉取可用模型表，写入 ~/.dsh/.env）
  const configSection = element(doc, 'div', 'panel-section');
  const configDetails = element(doc, 'details', 'panel-details config-details');
  const configSummary = element(doc, 'summary');
  const configTitle = element(doc, 'span');
  configTitle.textContent = '语音引擎';
  const configSummaryRight = element(doc, 'span', 'details-summary-right');
  const configSummaryValue = element(doc, 'span', 'config-summary-val');
  configSummaryValue.textContent = '默认优化';
  const configChevron = element(doc, 'span', 'details-chevron');
  configChevron.append(createSvgIcon(doc, 13, '1.9', CHEVRON_PARTS));
  configSummaryRight.append(configSummaryValue, configChevron);
  configSummary.append(configTitle, configSummaryRight);

  const configForm = element(doc, 'div', 'config-form');

  // 模式切换：默认 / Live / 级联
  const modeGroup = element(doc, 'div', 'seg-group');
  modeGroup.setAttribute('role', 'radiogroup');
  modeGroup.setAttribute('aria-label', '语音引擎模式');
  const modeBtns = new Map<VoiceMode, HTMLButtonElement>();
  for (const mode of VOICE_MODES) {
    const btn = element(doc, 'button', 'seg-btn');
    btn.type = 'button';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', mode === 'default' ? 'true' : 'false');
    btn.textContent = VOICE_MODE_LABELS[mode];
    modeGroup.append(btn);
    modeBtns.set(mode, btn);
  }
  const modeField = createFieldRow(doc, '运行模式', modeGroup);

  const configTip = element(doc, 'div', 'config-tip');
  const configTipIcon = element(doc, 'span', 'config-tip-icon');
  configTipIcon.append(createSvgIcon(doc, 12, '1.9', SPARK_PARTS));
  const configTipText = element(doc, 'span');
  configTipText.textContent = OPTIMIZED_DEFAULT_TIP;
  configTip.append(configTipIcon, configTipText);

  // 面板 A：默认（深度调优推荐方案，仅需一个 DASHSCOPE_API_KEY）
  const defaultPane = element(doc, 'div', 'config-pane');
  const defaultKeyField = createApiKeyField(
    doc,
    'DASHSCOPE_API_KEY',
    '输入 DashScope API Key',
  );
  defaultPane.append(defaultKeyField.row);

  // 面板 B：Live（自定义 OpenAI Realtime 兼容端点）
  const livePane = element(doc, 'div', 'config-pane');
  livePane.hidden = true;
  const liveCard = element(doc, 'div', 'config-subgroup');
  const liveBaseUrlInput = createTextInput(
    doc,
    'Live Base URL',
    DEFAULT_OPENAI_BASE_URL,
    512,
  );
  const liveKeyField = createApiKeyField(doc, 'API Key', '输入 OpenAI 兼容 API Key');
  const liveModelPicker = createModelPicker(doc, '拉取可用模型');
  const liveModelInput = createTextInput(
    doc,
    'Live 模型',
    `默认：${DEFAULT_LIVE_MODEL}`,
  );
  const liveAsrModelInput = createTextInput(
    doc,
    '转写模型（可选）',
    `默认：${DEFAULT_LIVE_ASR_MODEL}`,
  );
  liveCard.append(
    createFieldRow(doc, 'Base URL', liveBaseUrlInput),
    liveKeyField.row,
    liveModelPicker.container,
    createFieldRow(doc, 'Live 模型', liveModelInput),
    createFieldRow(doc, '转写模型（可选）', liveAsrModelInput),
  );
  livePane.append(liveCard);

  // 面板 C：级联（独立 STT + TTS，支持一键复用 STT 端点与 Key）
  const cascadePane = element(doc, 'div', 'config-pane');
  cascadePane.hidden = true;

  const sttCard = element(doc, 'div', 'config-subgroup');
  const sttCardHead = element(doc, 'div', 'config-card-head');
  const sttCardTitle = element(doc, 'span', 'config-card-title');
  sttCardTitle.textContent = 'STT · 语音识别';
  sttCardHead.append(sttCardTitle);
  const sttSubtip = element(doc, 'div', 'config-subtip');
  sttSubtip.textContent = 'HTTP 地址走 /audio/transcriptions，wss:// 走 Realtime 转写';
  const cascadeSttBaseUrlInput = createTextInput(
    doc,
    'STT Base URL',
    DEFAULT_OPENAI_BASE_URL,
    512,
  );
  const cascadeSttKeyField = createApiKeyField(doc, 'STT API Key', '输入 STT API Key');
  const cascadeSttPicker = createModelPicker(doc, '拉取 STT 模型');
  const cascadeSttModelInput = createTextInput(
    doc,
    'STT 模型',
    `默认：${DEFAULT_CASCADE_STT_MODEL}`,
  );
  sttCard.append(
    sttCardHead,
    sttSubtip,
    createFieldRow(doc, 'Base URL', cascadeSttBaseUrlInput),
    cascadeSttKeyField.row,
    cascadeSttPicker.container,
    createFieldRow(doc, 'STT 模型', cascadeSttModelInput),
  );

  const ttsCard = element(doc, 'div', 'config-subgroup');
  const ttsCardHead = element(doc, 'div', 'config-card-head');
  const ttsCardTitle = element(doc, 'span', 'config-card-title');
  ttsCardTitle.textContent = 'TTS · 语音合成';
  ttsCardHead.append(ttsCardTitle);
  const cascadeTtsReuseSwitch = createSwitchRow(doc, '复用 STT 地址与 Key', false);
  const cascadeTtsEndpointBox = element(doc, 'div', 'config-pane');
  const cascadeTtsBaseUrlInput = createTextInput(
    doc,
    'TTS Base URL',
    DEFAULT_OPENAI_BASE_URL,
    512,
  );
  const cascadeTtsKeyField = createApiKeyField(doc, 'TTS API Key', '输入 TTS API Key');
  cascadeTtsEndpointBox.append(
    createFieldRow(doc, 'Base URL', cascadeTtsBaseUrlInput),
    cascadeTtsKeyField.row,
  );
  const cascadeTtsPicker = createModelPicker(doc, '拉取 TTS 模型');
  const cascadeTtsModelInput = createTextInput(
    doc,
    'TTS 模型',
    `默认：${DEFAULT_CASCADE_TTS_MODEL}`,
  );
  const cascadeTtsVoiceInput = createTextInput(
    doc,
    'TTS 音色（可选）',
    `默认：${DEFAULT_CASCADE_TTS_VOICE}`,
  );
  ttsCard.append(
    ttsCardHead,
    cascadeTtsReuseSwitch.row,
    cascadeTtsEndpointBox,
    cascadeTtsPicker.container,
    createFieldRow(doc, 'TTS 模型', cascadeTtsModelInput),
    createFieldRow(doc, '音色（可选）', cascadeTtsVoiceInput),
  );
  cascadePane.append(sttCard, ttsCard);

  const configEnvHint = element(doc, 'div', 'config-env-hint');
  configEnvHint.textContent = '保存后写入 ~/.dsh/.env';

  const configFeedback = element(doc, 'div', 'config-feedback');
  configFeedback.hidden = true;

  const configActions = element(doc, 'div', 'config-actions');
  const configResetBtn = element(doc, 'button', 'ghost-action');
  configResetBtn.type = 'button';
  configResetBtn.textContent = '恢复默认优化';
  configResetBtn.disabled = true;
  const configApplyBtn = element(doc, 'button', 'primary-action');
  configApplyBtn.type = 'button';
  configApplyBtn.textContent = '写入 .env 并重载';
  configApplyBtn.disabled = true;
  configActions.append(configResetBtn, configApplyBtn);

  configForm.append(
    modeField,
    configTip,
    defaultPane,
    livePane,
    cascadePane,
    configEnvHint,
    configFeedback,
    configActions,
  );
  configDetails.append(configSummary, configForm);
  configSection.append(configDetails);

  // 区块 3：外观
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
  const soundSwitch = createSwitchRow(doc, '动态音效', prefs.soundEnabled);
  const retroSwitch = createSwitchRow(doc, '8-bit 星芒彩蛋', prefs.retroSpark);

  const sfxTestRow = element(doc, 'div', 'setting-row sfx-test-row');
  const sfxTestTitle = element(doc, 'span', 'row-title');
  sfxTestTitle.textContent = '开麦音效试听';
  const sfxTestBtn = element(doc, 'button', 'ghost-action');
  sfxTestBtn.type = 'button';
  sfxTestBtn.textContent = '试听';
  sfxTestBtn.setAttribute('aria-label', '试听开麦音效');
  sfxTestRow.append(sfxTestTitle, sfxTestBtn);

  appearSection.append(
    appearLabel,
    sizeRow,
    bubbleSwitch.row,
    mirrorSwitch.row,
    soundSwitch.row,
    retroSwitch.row,
    sfxTestRow,
  );

  // 区块 4：默认折叠的表情预览
  const exprSection = element(doc, 'div', 'panel-section');
  const exprDetails = element(doc, 'details', 'panel-details expr-details');
  const exprSummary = element(doc, 'summary');
  const exprTitle = element(doc, 'span');
  exprTitle.textContent = '表情预览';
  const exprSummaryRight = element(doc, 'span', 'details-summary-right');
  const exprCurrent = element(doc, 'span');
  exprCurrent.textContent = SPRITE_LABELS.calm;
  const exprChevron = element(doc, 'span', 'details-chevron');
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

  panelBody.append(sessionSection, configSection, appearSection, exprSection);

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
    configSection,
    configDetails,
    configSummaryValue,
    configTip,
    configTipText,
    modeBtns,
    defaultPane,
    defaultKeyField,
    livePane,
    liveBaseUrlInput,
    liveKeyField,
    liveModelPicker,
    liveModelInput,
    liveAsrModelInput,
    cascadePane,
    cascadeSttBaseUrlInput,
    cascadeSttKeyField,
    cascadeSttPicker,
    cascadeSttModelInput,
    cascadeTtsReuseInput: cascadeTtsReuseSwitch.input,
    cascadeTtsEndpointBox,
    cascadeTtsBaseUrlInput,
    cascadeTtsKeyField,
    cascadeTtsPicker,
    cascadeTtsModelInput,
    cascadeTtsVoiceInput,
    configEnvHint,
    configFeedback,
    configResetBtn,
    configApplyBtn,
    sizeInput,
    sizeReadout,
    mirrorInput: mirrorSwitch.input,
    bubbleInput: bubbleSwitch.input,
    soundInput: soundSwitch.input,
    retroInput: retroSwitch.input,
    sfxTestBtn,
    exprDetails,
    exprCurrent,
    chips,
    resetBtn,
  };
}
