/**
 * 桌宠外壳样式（对齐 dsh 原生主题令牌与 Popover 布局）。
 *
 * 宿主守卫写在 document.head，压过按 fixed + z-index 套毛玻璃的页面皮肤。
 * 组件样式只进 Shadow DOM，直接继承宿主 `--dsw-alias-*` / `--dsw-elevation-panel` /
 * `--dsw-radius-*` / `--dsw-font-family` 变量（穿透 Shadow DOM），脱离宿主时由
 * `--pet-fb-*` 兜底。
 */

export const HOST_GUARD_CSS = [
  'html #dsh-voice-pet-host, body #dsh-voice-pet-host { position: fixed !important; background: transparent !important; background-image: none !important; border: 0 !important; outline: 0 !important; box-shadow: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; filter: none !important; pointer-events: none !important; z-index: 9998 !important; padding: 0 !important; margin: 0 !important; }',
  'html #dsh-voice-pet-host::before, html #dsh-voice-pet-host::after { content: none !important; display: none !important; }',
].join('\n');

export const WIDGET_CSS = `
:host {
  /* 脱离 dsh 宿主时的浅色兜底值 */
  --pet-fb-bg: #ffffff;
  --pet-fb-bg-subtle: #f1f3f5;
  --pet-fb-bg-hover: rgba(15, 17, 21, 0.05);
  --pet-fb-bg-active: rgba(15, 17, 21, 0.09);
  --pet-fb-ink: #0f1115;
  --pet-fb-ink-2: #61666b;
  --pet-fb-ink-3: #81858c;
  --pet-fb-border: rgba(0, 0, 0, 0.10);
  --pet-fb-border-subtle: rgba(0, 0, 0, 0.05);
  --pet-fb-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.11), 0 4px 12px rgba(0, 0, 0, 0.06), 0 0 18px rgba(0, 0, 0, 0.03);
  --pet-fb-accent: #4176e6;
  --pet-fb-ok: #16a34a;
  --pet-fb-warn: #d97706;
  --pet-fb-err: #dc2626;

  /* 优先继承 dsh 宿主设计令牌，深浅主题实时联动不穿帮 */
  --pet-bg: var(--dsw-alias-bg-layer-2, var(--pet-fb-bg));
  --pet-bg-subtle: var(--dsw-alias-bg-layer-3, var(--pet-fb-bg-subtle));
  --pet-bg-hover: var(--dsw-alias-interactive-bg-hover, var(--pet-fb-bg-hover));
  --pet-bg-active: var(--dsw-alias-interactive-bg-active, var(--pet-fb-bg-active));
  --pet-ink: var(--dsw-alias-label-primary, var(--pet-fb-ink));
  --pet-ink-2: var(--dsw-alias-label-secondary, var(--pet-fb-ink-2));
  --pet-ink-3: var(--dsw-alias-label-tertiary, var(--pet-fb-ink-3));
  --pet-border: var(--dsw-alias-border-l2, var(--pet-fb-border));
  --pet-border-subtle: var(--dsw-alias-border-l1, var(--pet-fb-border-subtle));
  --pet-shadow: var(--dsw-elevation-panel, var(--pet-fb-shadow));
  --pet-accent: var(--dsw-alias-brand-primary-new-colorprimary-new-color, var(--pet-fb-accent));
  --pet-ok: var(--dsw-alias-state-success-primary, var(--pet-fb-ok));
  --pet-warn: var(--dsw-alias-state-warn-primary, var(--pet-fb-warn));
  --pet-err: var(--dsw-alias-state-error-primary, var(--pet-fb-err));
  --pet-radius: var(--dsw-radius-md, 12px);
  --pet-radius-sm: var(--dsw-radius-sm, 8px);
  --pet-radius-xs: var(--dsw-radius-xs, 4px);
  --pet-font: var(--dsw-font-family, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
  --pet-mono: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);

  display: block;
  width: 100%;
  height: 100%;
  color-scheme: light dark;
  font: 12.5px/1.45 var(--pet-font);
  color: var(--pet-ink);
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) {
  :host {
    --pet-fb-bg: #2c2c2e;
    --pet-fb-bg-subtle: #353638;
    --pet-fb-bg-hover: rgba(255, 255, 255, 0.07);
    --pet-fb-bg-active: rgba(255, 255, 255, 0.13);
    --pet-fb-ink: #f5f6f7;
    --pet-fb-ink-2: #cfd3d6;
    --pet-fb-ink-3: #979da6;
    --pet-fb-border: rgba(255, 255, 255, 0.12);
    --pet-fb-border-subtle: rgba(255, 255, 255, 0.06);
    --pet-fb-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.14), 0 8px 24px rgba(0, 0, 0, 0.42), 0 0 16px rgba(0, 0, 0, 0.22);
    --pet-fb-accent: #5b8ef0;
    --pet-fb-ok: #22c55e;
    --pet-fb-warn: #f59e0b;
    --pet-fb-err: #f87171;
  }
}
:host, :host *, :host *::before, :host *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.pet-root, .pet-root * { -webkit-tap-highlight-color: transparent; }

.pet-root {
  position: relative;
  width: var(--pet-size, 140px);
  height: var(--pet-size, 140px);
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}

/* 立绘双层动效容器（外层 Q 弹按压 + 内层 RMS 说话摇摆互不覆盖） */
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
  object-position: center bottom;
  pointer-events: auto;
  -webkit-user-drag: none;
  user-select: none;
  touch-action: none;
}
.pet-root.cursor-grab .pet-img { cursor: grab; }
.pet-root.cursor-grabbing .pet-img { cursor: grabbing; }
.pet-img:focus-visible { outline: 2px solid var(--pet-accent); outline-offset: 2px; border-radius: var(--pet-radius); }

/* 贴合立绘底缘的微缩状态胶囊（待机时隐身，活跃时轻显） */
.pet-status {
  position: absolute;
  left: 50%;
  bottom: 2px;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 18px;
  padding: 0 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--pet-bg) 90%, transparent);
  box-shadow: var(--pet-shadow);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  font-size: 10.5px;
  font-weight: 500;
  color: var(--pet-ink-2);
  white-space: nowrap;
  pointer-events: none;
  z-index: 5;
  opacity: 0;
  transition: opacity 0.18s ease;
}
.pet-status.is-visible { opacity: 1; }
.pet-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--pet-ink-3);
  flex-shrink: 0;
}
.pet-status.is-connecting .pet-status-dot { background: var(--pet-warn); animation: pet-pulse 1s ease-in-out infinite; }
.pet-status.is-live .pet-status-dot { background: var(--pet-ok); animation: pet-pulse 1.5s ease-in-out infinite; }
.pet-status.is-speaking .pet-status-dot { background: var(--pet-accent); animation: pet-pulse 0.75s ease-in-out infinite; }
.pet-status.is-speaking { color: var(--pet-ink); }
@keyframes pet-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.35); opacity: 0.55; }
}

/* 顶部悬浮胶囊工具栏 + 透明 hover 桥接垫片（消灭立绘到工具栏的缝隙断崖） */
.pet-tools {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 6px);
  transform: translateX(-50%) translateY(3px);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--pet-bg) 94%, transparent);
  box-shadow: var(--pet-shadow);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  z-index: 6;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.pet-tools::after {
  content: '';
  position: absolute;
  left: -8px;
  right: -8px;
  top: -4px;
  bottom: -12px;
  z-index: -1;
}
.pet-tools.below {
  bottom: auto;
  top: calc(100% + 6px);
  transform: translateX(-50%) translateY(-3px);
}
.pet-tools.below::after {
  top: -12px;
  bottom: -4px;
}
.pet-root:hover .pet-tools,
.pet-root:focus-within .pet-tools,
.pet-root.tools-pinned .pet-tools,
.pet-root.panel-open .pet-tools {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
  pointer-events: auto;
}

.icon-btn {
  width: 28px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--pet-ink-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  pointer-events: auto;
  transition: background 0.14s ease, color 0.14s ease;
}
.icon-btn:hover, .icon-btn:focus-visible {
  background: var(--pet-bg-hover);
  color: var(--pet-ink);
  outline: none;
}
.icon-btn[aria-pressed="true"] {
  background: var(--pet-bg-active);
  color: var(--pet-ink);
}
.icon-btn.is-mic-live {
  background: color-mix(in srgb, var(--pet-ok) 16%, transparent);
  color: var(--pet-ok);
}
.icon-btn.is-mute-hot {
  background: color-mix(in srgb, var(--pet-accent) 16%, transparent);
  color: var(--pet-accent);
}
.icon-btn:disabled {
  opacity: 0.36;
  cursor: default;
  pointer-events: none;
}

/* 实时字幕气泡（dsh 原生浮层卡，flex gap 跳过 hidden 节点，底对齐防裁切） */
.pet-bubble {
  position: absolute;
  bottom: 4px;
  z-index: 4;
  width: max-content;
  min-width: 164px;
  max-width: min(276px, calc(100vw - 24px));
  max-height: min(34vh, 240px);
  overflow-y: auto;
  padding: 10px 12px;
  border-radius: var(--pet-radius);
  background: color-mix(in srgb, var(--pet-bg) 94%, transparent);
  box-shadow: var(--pet-shadow);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--pet-ink);
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: auto;
  opacity: 0;
  visibility: hidden;
  transform: translateY(4px);
  transition: opacity 0.24s ease, transform 0.24s ease, visibility 0s linear 0.24s;
}
.pet-bubble.align-top { bottom: auto; top: 0; }
.pet-bubble.side-left { right: calc(100% + 10px); left: auto; }
.pet-bubble.side-right { left: calc(100% + 10px); right: auto; }
.pet-bubble.show {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
  transition: opacity 0.24s ease, transform 0.24s ease, visibility 0s linear 0s;
}
.pet-root.panel-open .pet-bubble {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}
.pet-bubble > [hidden] { display: none !important; }

.asr-row {
  padding-left: 8px;
  border-left: 2px solid var(--pet-border);
  font-size: 12px;
  line-height: 1.45;
  color: var(--pet-ink-2);
  word-break: break-word;
}
.reply-row {
  font-size: 13px;
  line-height: 1.52;
  color: var(--pet-ink);
  word-break: break-word;
}
.lane-pill {
  display: inline-block;
  vertical-align: 1px;
  margin-right: 6px;
  padding: 1px 5px;
  border-radius: var(--pet-radius-xs);
  background: var(--pet-bg-subtle);
  border: 1px solid var(--pet-border-subtle);
  font: 600 10px/1.3 var(--pet-mono);
  color: var(--pet-ink-2);
}
.lane-pill[hidden] { display: none; }

.delegate-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  align-self: flex-start;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--pet-bg-subtle);
  border: 1px solid var(--pet-border-subtle);
  font-size: 11.5px;
  color: var(--pet-ink-2);
}
.delegate-badge svg { color: var(--pet-accent); flex-shrink: 0; }

.note-row {
  font-size: 12px;
  font-weight: 500;
  color: var(--pet-warn);
  word-break: break-word;
}

.hint-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-top: 6px;
  border-top: 1px solid var(--pet-border-subtle);
  font-size: 11.5px;
  color: var(--pet-ink-3);
}
.hint-row:first-child { padding-top: 0; border-top: 0; }
.hint-dismiss {
  flex-shrink: 0;
  white-space: nowrap;
  padding: 2px 8px;
  border-radius: var(--pet-radius-xs);
  border: 1px solid var(--pet-border);
  background: transparent;
  color: var(--pet-ink-2);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.hint-dismiss:hover { background: var(--pet-bg-hover); color: var(--pet-ink); }

/* 结构化设置浮窗（388px · 固定头 / 可滚体 / 固定尾） */
.pet-panel {
  position: absolute;
  bottom: 0;
  z-index: 8;
  width: min(388px, calc(100vw - 24px));
  max-height: min(600px, calc(100vh - 24px));
  border-radius: var(--pet-radius);
  background: color-mix(in srgb, var(--pet-bg) 96%, transparent);
  box-shadow: var(--pet-shadow);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  color: var(--pet-ink);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  pointer-events: auto;
  user-select: text;
}
.pet-panel[hidden] { display: none; }
.pet-panel.align-top { bottom: auto; top: 0; }
.pet-panel.side-left { right: calc(100% + 10px); left: auto; }
.pet-panel.side-right { left: calc(100% + 10px); right: auto; }
.pet-panel button, .pet-panel label, .pet-panel summary { user-select: none; }

.panel-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 10px 10px 13px;
  border-bottom: 1px solid var(--pet-border-subtle);
}
.panel-title-group {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.panel-title-group strong {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.mode-tag {
  padding: 1px 6px;
  border-radius: var(--pet-radius-xs);
  background: var(--pet-bg-subtle);
  font: 500 10.5px/1.4 var(--pet-mono);
  color: var(--pet-ink-2);
}

.panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.panel-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.panel-section + .panel-section {
  padding-top: 10px;
  border-top: 1px solid var(--pet-border-subtle);
}
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.section-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--pet-ink-3);
}
.ghost-action {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px;
  border: 0;
  border-radius: var(--pet-radius-xs);
  background: transparent;
  color: var(--pet-ink-2);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.ghost-action:hover:not(:disabled) { background: var(--pet-bg-hover); color: var(--pet-ink); }
.ghost-action:disabled { opacity: 0.45; cursor: default; }

.state-alert {
  padding: 6px 8px;
  border-radius: var(--pet-radius-sm);
  background: var(--pet-bg-subtle);
  font-size: 11.5px;
  color: var(--pet-ink-2);
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.state-alert[hidden] { display: none; }

.session-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 126px;
  overflow-y: auto;
}
.session-empty {
  padding: 6px 8px;
  font-size: 11.5px;
  color: var(--pet-ink-3);
}
.session-btn {
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--pet-radius-sm);
  background: transparent;
  color: var(--pet-ink-2);
  font: inherit;
  font-size: 12.5px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s ease, color 0.12s ease;
}
.session-btn:hover:not(:disabled) { background: var(--pet-bg-hover); color: var(--pet-ink); }
.session-btn:disabled { opacity: 0.5; cursor: default; }
.session-btn[aria-pressed="true"] {
  background: var(--pet-bg-active);
  color: var(--pet-ink);
  font-weight: 500;
}
.session-btn .s-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-btn .s-check {
  flex-shrink: 0;
  color: var(--pet-accent);
  opacity: 0;
  display: inline-flex;
}
.session-btn[aria-pressed="true"] .s-check { opacity: 1; }

.setting-row {
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12.5px;
  color: var(--pet-ink);
  cursor: pointer;
}
.setting-row .row-title { color: var(--pet-ink-2); }
.size-control {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: flex-end;
}
.size-readout {
  width: 38px;
  text-align: right;
  font: 11.5px/1 var(--pet-mono);
  font-variant-numeric: tabular-nums;
  color: var(--pet-ink-3);
}

.range-input {
  -webkit-appearance: none;
  appearance: none;
  width: 116px;
  height: 4px;
  border-radius: 999px;
  background: var(--pet-border);
  outline: none;
  cursor: pointer;
}
.range-input::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--pet-ink);
  border: 2px solid var(--pet-bg);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  cursor: pointer;
}
.range-input::-moz-range-thumb {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--pet-ink);
  border: 2px solid var(--pet-bg);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  cursor: pointer;
}

.switch {
  position: relative;
  width: 30px;
  height: 17px;
  flex-shrink: 0;
}
.switch input {
  position: absolute;
  inset: 0;
  opacity: 0;
  margin: 0;
  cursor: pointer;
}
.switch-track {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: var(--pet-border);
  transition: background 0.16s ease;
}
.switch-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--pet-bg);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.22);
  transition: transform 0.16s ease;
}
.switch input:checked + .switch-track { background: var(--pet-accent); }
.switch input:checked + .switch-track::after { transform: translateX(13px); }
.switch input:focus-visible + .switch-track { outline: 2px solid var(--pet-accent); outline-offset: 2px; }
.switch input:disabled { cursor: default; }
.switch input:disabled + .switch-track { opacity: 0.4; }
.setting-row.is-disabled { cursor: default; }
.setting-row.is-disabled .row-title { color: var(--pet-ink-3); }
.sfx-test-row { cursor: default; }

.panel-details summary {
  list-style: none;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
  color: var(--pet-ink-2);
  font-size: 12px;
}
.panel-details summary::-webkit-details-marker { display: none; }
.details-summary-right {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  font-size: 11px;
  color: var(--pet-ink-3);
}
.config-summary-val {
  max-width: 216px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.details-chevron {
  display: inline-flex;
  flex-shrink: 0;
  transition: transform 0.16s ease;
}
.panel-details[open] .details-chevron { transform: rotate(90deg); }

/* 语音引擎配置表单 */
.config-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 6px;
}
.config-form [hidden] { display: none !important; }
.config-pane {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.config-subgroup {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 8px;
  border-radius: var(--pet-radius-sm);
  background: color-mix(in srgb, var(--pet-bg-subtle) 65%, transparent);
  border: 1px solid var(--pet-border-subtle);
}
.config-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.config-card-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--pet-ink);
}
.config-tip {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 7px 8px;
  border-radius: var(--pet-radius-sm);
  background: color-mix(in srgb, var(--pet-accent) 9%, var(--pet-bg-subtle));
  border: 1px solid color-mix(in srgb, var(--pet-accent) 22%, var(--pet-border-subtle));
  font-size: 11px;
  line-height: 1.45;
  color: var(--pet-ink-2);
}
.config-tip.is-subtle {
  background: var(--pet-bg-subtle);
  border-color: var(--pet-border-subtle);
}
.config-tip-icon {
  display: inline-flex;
  margin-top: 2px;
  color: var(--pet-accent);
  flex-shrink: 0;
}
.config-tip.is-subtle .config-tip-icon {
  color: var(--pet-ink-3);
}
.config-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.config-field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.config-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--pet-ink-2);
}
.key-meta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.key-badge {
  padding: 1px 5px;
  border-radius: var(--pet-radius-xs);
  background: var(--pet-bg-subtle);
  font: 500 10px/1.4 var(--pet-mono);
  color: var(--pet-ink-3);
  max-width: 176px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.key-badge.is-set {
  background: color-mix(in srgb, var(--pet-ok) 12%, transparent);
  color: var(--pet-ok);
}
.key-badge.is-clearing {
  background: color-mix(in srgb, var(--pet-warn) 14%, transparent);
  color: var(--pet-warn);
}
.key-clear-btn {
  padding: 0 4px;
  height: 18px;
  border: 0;
  border-radius: var(--pet-radius-xs);
  background: transparent;
  color: var(--pet-ink-3);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.key-clear-btn:hover:not(:disabled) {
  background: var(--pet-bg-hover);
  color: var(--pet-ink);
}
.key-clear-btn:disabled { opacity: 0.4; cursor: default; }

.seg-group {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2px;
  padding: 2px;
  border-radius: var(--pet-radius-sm);
  background: var(--pet-bg-subtle);
  border: 1px solid var(--pet-border-subtle);
}
.seg-btn {
  height: 25px;
  padding: 0 6px;
  border: 0;
  border-radius: calc(var(--pet-radius-sm) - 2px);
  background: transparent;
  color: var(--pet-ink-2);
  font: inherit;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background 0.12s ease, color 0.12s ease, box-shadow 0.12s ease;
}
.seg-btn:hover:not(:disabled) { color: var(--pet-ink); }
.seg-btn[aria-checked="true"] {
  background: var(--pet-bg);
  color: var(--pet-ink);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.10);
}
.seg-btn:disabled { opacity: 0.45; cursor: default; }

.config-input {
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--pet-radius-sm);
  border: 1px solid var(--pet-border);
  background: var(--pet-bg);
  color: var(--pet-ink);
  font-family: var(--pet-mono);
  font-size: 11.5px;
  outline: none;
  transition: border-color 0.14s ease, box-shadow 0.14s ease;
}
.config-input::placeholder {
  color: var(--pet-ink-3);
  font-family: var(--pet-font);
}
.config-input:focus-visible {
  border-color: var(--pet-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--pet-accent) 20%, transparent);
}
.config-input:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 可用模型表（able table / GET /models） */
.model-picker {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.model-fetch-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.fetch-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border-radius: var(--pet-radius-xs);
  border: 1px solid var(--pet-border);
  background: var(--pet-bg);
  color: var(--pet-ink);
  font: inherit;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.fetch-btn:hover:not(:disabled) {
  background: var(--pet-bg-hover);
  border-color: var(--pet-accent);
}
.fetch-btn:disabled { opacity: 0.45; cursor: default; }
.model-fetch-status {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--pet-ink-3);
}
.model-fetch-status.is-err { color: var(--pet-err); }
.model-fetch-status.is-ok { color: var(--pet-ok); }

.model-table-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 5px;
  border-radius: var(--pet-radius-sm);
  border: 1px solid var(--pet-border-subtle);
  background: var(--pet-bg);
}
.model-filter {
  width: 100%;
  height: 24px;
  padding: 0 7px;
  border-radius: var(--pet-radius-xs);
  border: 1px solid var(--pet-border-subtle);
  background: var(--pet-bg-subtle);
  color: var(--pet-ink);
  font: inherit;
  font-size: 11px;
  outline: none;
}
.model-filter:focus-visible { border-color: var(--pet-accent); }
.model-table-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 132px;
  overflow-y: auto;
}
.model-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  min-height: 24px;
  padding: 2px 5px;
  border-radius: var(--pet-radius-xs);
  border: 1px solid transparent;
  background: transparent;
  transition: background 0.1s ease, border-color 0.1s ease;
}
.model-row:hover { background: var(--pet-bg-hover); }
.model-row.is-selected {
  background: color-mix(in srgb, var(--pet-accent) 12%, transparent);
  border-color: color-mix(in srgb, var(--pet-accent) 32%, transparent);
}
.model-row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--pet-ink);
  font-family: var(--pet-mono);
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}
.model-row-id {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-row-owner {
  flex-shrink: 0;
  font-family: var(--pet-font);
  font-size: 10px;
  color: var(--pet-ink-3);
}
.model-row-alt {
  flex-shrink: 0;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--pet-radius-xs);
  border: 1px solid var(--pet-border);
  background: var(--pet-bg-subtle);
  color: var(--pet-ink-2);
  font: inherit;
  font-size: 10px;
  cursor: pointer;
}
.model-row-alt:hover {
  border-color: var(--pet-accent);
  color: var(--pet-accent);
}
.model-row-alt.is-selected {
  border-color: var(--pet-accent);
  color: var(--pet-accent);
  background: color-mix(in srgb, var(--pet-accent) 12%, transparent);
}
.model-empty {
  padding: 6px 4px;
  font-size: 11px;
  color: var(--pet-ink-3);
  text-align: center;
}

.config-subtip {
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--pet-ink-3);
}
.config-env-hint {
  font: 400 10.5px/1.3 var(--pet-mono);
  color: var(--pet-ink-3);
}
.config-feedback {
  padding: 5px 8px;
  border-radius: var(--pet-radius-xs);
  background: var(--pet-bg-subtle);
  font-size: 11px;
  line-height: 1.4;
  color: var(--pet-ink-2);
  overflow-wrap: anywhere;
}
.config-feedback.is-ok {
  color: var(--pet-ok);
  background: color-mix(in srgb, var(--pet-ok) 11%, transparent);
}
.config-feedback.is-err {
  color: var(--pet-err);
  background: color-mix(in srgb, var(--pet-err) 11%, transparent);
}
.config-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 2px;
}
.primary-action {
  height: 27px;
  padding: 0 11px;
  border: 0;
  border-radius: var(--pet-radius-sm);
  background: var(--pet-accent);
  color: #ffffff;
  font: inherit;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.14s ease, filter 0.14s ease;
}
.primary-action:hover:not(:disabled) { filter: brightness(1.06); }
.primary-action:disabled { opacity: 0.42; cursor: default; }

.expr-strip {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 4px;
  margin-top: 6px;
}
.expr-chip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 4px 2px;
  border-radius: var(--pet-radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--pet-ink-2);
  font: inherit;
  font-size: 10px;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}
.expr-chip:hover { background: var(--pet-bg-hover); color: var(--pet-ink); }
.expr-chip[aria-pressed="true"] {
  border-color: var(--pet-accent);
  background: color-mix(in srgb, var(--pet-accent) 12%, transparent);
  color: var(--pet-ink);
}
.expr-chip img { width: 32px; height: 32px; object-fit: contain; pointer-events: none; }

.panel-foot {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px 7px 13px;
  border-top: 1px solid var(--pet-border-subtle);
  background: color-mix(in srgb, var(--pet-bg-subtle) 55%, transparent);
}
.bound-id {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--pet-ink-3);
}

@media (prefers-contrast: more) {
  .pet-bubble, .pet-panel, .pet-tools, .pet-status {
    background: Canvas;
    color: CanvasText;
    border: 1.5px solid CanvasText;
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
  .asr-row, .section-label, .bound-id, .hint-row { color: CanvasText; }
}
@media (hover: none) {
  .pet-root.tools-pinned .pet-tools { opacity: 1; pointer-events: auto; }
}
@media (prefers-reduced-motion: reduce) {
  .pet-status-dot { animation: none; }
  .pet-bubble, .pet-tools, .pet-status, .details-chevron { transition: none; }
}
`;
