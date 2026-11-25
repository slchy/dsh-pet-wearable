/**
 * 桌宠外壳样式。
 *
 * 宿主守卫写在 document.head，压过按 fixed + z-index 套毛玻璃的页面皮肤。
 * 组件样式只进 Shadow DOM，立绘的规则漏不出去，宿主皮肤也进不来。
 */

export const HOST_GUARD_CSS = [
  'html #dsh-voice-pet-host, body #dsh-voice-pet-host { position: fixed !important; background: transparent !important; background-image: none !important; border: 0 !important; outline: 0 !important; box-shadow: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; filter: none !important; pointer-events: none !important; z-index: 9998 !important; padding: 0 !important; margin: 0 !important; }',
  'html #dsh-voice-pet-host::before, html #dsh-voice-pet-host::after { content: none !important; display: none !important; }',
].join('\n');

export const WIDGET_CSS = `
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

