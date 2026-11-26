/**
 * Gemini-chan 浮层桌宠。
 *
 * 外壳锁在浅色 DOM 的固定宿主上，内部全部进 Shadow DOM：dsh 的皮肤进不来，
 * 立绘的样式也漏不出去。几何（吸附、锚点、凸包）只调 `pet-geometry.ts`。
 * 按压回弹和透明穿透的口径来自 dsh-whale-widget@0.3.16
 * （MIT, Copyright (c) 2026 MeteorNOX），这里按语音桌宠重写过。
 *
 * 这一文件只留单实例守卫、定时器、监听、fetch 和 DOM 写回。
 * 偏好、立绘、口型、界面状态、会话投影、拖拽和命中都在旁边的 `pet-*.ts`。
 */
import {
  createVoiceClient,
  type VoiceClient,
  type VoiceClientEvent,
} from './client.ts';
import {
  PRESS_SQUISH_TRANSFORM,
  buildAlphaClipPath,
  clamp,
  hasOpaqueProbePixels,
  resolveAnchorPosition,
  shouldMirrorArt,
} from './pet-geometry.ts';
import {
  GUARD_STYLE_ID,
  buildPetShell,
  createCheckIcon,
} from './pet-dom.ts';
import {
  classifyRelease,
  dragPosition,
  notePointerMove,
  type DragGesture,
} from './pet-drag.ts';
import { HIT_SIZE, samplePetHit } from './pet-hit.ts';
import { clampSliderSize, loadPrefs, savePrefs } from './pet-prefs.ts';
import {
  projectHostState,
  type SessionRow,
} from './pet-session.ts';
import {
  SPRITE_LABELS,
  SPRITE_NAMES,
  armPreview,
  nextSpriteDelay,
  selectSprite,
  spriteUrl,
  type SpriteName,
} from './pet-sprites.ts';
import { HOST_GUARD_CSS } from './pet-styles.ts';
import { idleTalkPose, stepTalk, type TalkPose } from './pet-talk.ts';
import {
  BUBBLE_IDLE_MS,
  NOTE_MS,
  adoptSprite,
  bubbleView,
  dismissIdleBubble,
  initialPetUiState,
  markBubbleHover,
  reduceClientEvent,
  spriteStateOf,
  statusView,
  type PetEffect,
  type PetUiState,
} from './pet-ui.ts';

const MOUNT_KEY = '__DSH_VOICE_PET_MOUNTED__';
const HOST_MOVE = 'left .16s ease, top .16s ease';

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
  const style = document.createElement('style');
  style.id = GUARD_STYLE_ID;
  style.textContent = HOST_GUARD_CSS;
  (document.head ?? document.documentElement).appendChild(style);
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function voiceSocketUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/dsh-voice/ws`;
}

function readViewport(): { w: number; h: number } {
  return { w: window.innerWidth, h: window.innerHeight };
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
  const {
    host, root, mirror, squish, talk, img, bubble, hint, hintDismiss,
    asrLine, asrBody, replyLine, replyLane, replyBody, badge, note,
    statusBar, statusText, tools, micBtn, muteBtn, gearBtn, panel, panelClose,
    pipelineTag, boundId, stateMessage, sessionList, createBtn, sizeInput,
    sizeReadout, mirrorInput, bubbleInput, exprDetails, exprCurrent, chips, resetBtn,
  } = buildPetShell(document, prefs);

  let ui: PetUiState = initialPetUiState(prefs);
  let bubbleSide: 'left' | 'right' = 'left';
  let client: VoiceClient | null = null;
  let drag: DragGesture | null = null;
  let alpha: Uint8ClampedArray | null = null;
  let hitMode: 'rect' | 'alpha' = 'rect';
  let settingsOpen = false;
  let sessionBusy = false;
  let boundSessionId: string | null = null;
  let talkPose: TalkPose = idleTalkPose();
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

  function targetTop(): number {
    const parsed = Number.parseFloat(host.style.top);
    return Number.isFinite(parsed) ? parsed : host.getBoundingClientRect().top;
  }

  function placeTools(): void {
    tools.classList.toggle('below', targetTop() < 52);
  }

  function placeFloating(node: HTMLElement, side: 'left' | 'right'): void {
    const alignTop = targetTop() + prefs.sizePx / 2 < window.innerHeight / 2;
    node.classList.toggle('side-left', side === 'left');
    node.classList.toggle('side-right', side === 'right');
    node.classList.toggle('align-top', alignTop);
    node.style.transform = '';
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const margin = 10;
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
    return samplePetHit({
      clientX: point.clientX,
      clientY: point.clientY,
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      mirror: shouldMirrorArt(bubbleSide, prefs.mirrorOnLeft),
      hitMode,
      alpha,
    });
  }

  function renderExpression(): void {
    const selected = selectSprite(spriteStateOf(ui), Date.now());
    if (selected.state.previewName !== ui.previewName) {
      ui = { ...ui, previewName: selected.state.previewName };
    }
    const next = spriteUrl(selected.name);
    if (img.getAttribute('src') !== next) img.src = next;
    exprCurrent.textContent = SPRITE_LABELS[selected.name];
    for (const [sprite, chip] of chips) {
      chip.setAttribute('aria-pressed', sprite === selected.name ? 'true' : 'false');
    }
  }

  function armSpriteTimer(): void {
    window.clearTimeout(spriteTimer);
    const delay = nextSpriteDelay(spriteStateOf(ui), Date.now());
    if (delay === null) return;
    spriteTimer = window.setTimeout(() => { renderExpression(); }, delay);
  }

  function renderStatus(): void {
    const view = statusView(ui);
    const visible = view.mode !== 'off';
    statusBar.className = visible ? `pet-status is-visible is-${view.mode}` : 'pet-status is-off';
    statusBar.setAttribute('aria-label', view.label);
    statusText.textContent = visible ? view.label : '';
    micBtn.title = view.micLabel;
    micBtn.setAttribute('aria-label', view.micLabel);
    micBtn.setAttribute('aria-pressed', view.micPressed ? 'true' : 'false');
    micBtn.classList.toggle('is-mic-live', view.mode === 'live' || view.mode === 'speaking');
    muteBtn.disabled = ui.link !== 'live';
    muteBtn.classList.toggle('is-mute-hot', ui.speaking);
  }

  function renderBubble(): void {
    const view = bubbleView(ui);
    hint.hidden = view.hintHidden;
    asrLine.hidden = view.asrHidden;
    asrBody.textContent = view.asrText;
    replyLine.hidden = view.replyHidden;
    replyLane.hidden = view.laneHidden;
    replyLane.textContent = view.laneText;
    replyBody.textContent = view.replyText;
    badge.hidden = view.badgeHidden;
    note.hidden = view.noteHidden;
    note.textContent = view.noteText;
    bubble.classList.toggle('show', view.visible);
    if (view.visible) placeFloating(bubble, bubbleSide);
  }

  function scheduleCaptions(renderNow: boolean): void {
    window.clearTimeout(bubbleTimer);
    if (renderNow) renderBubble();
    bubbleTimer = window.setTimeout(() => {
      if (ui.bubbleHover) return;
      ui = dismissIdleBubble(ui);
      renderBubble();
    }, BUBBLE_IDLE_MS);
  }

  function scheduleNote(durationMs: number): void {
    window.clearTimeout(noteTimer);
    renderBubble();
    noteTimer = window.setTimeout(() => {
      ui = { ...ui, noteText: '' };
      renderBubble();
    }, durationMs);
  }

  function stopTalk(): void {
    ui = { ...ui, speaking: false };
    if (talkRaf !== 0) cancelAnimationFrame(talkRaf);
    talkRaf = 0;
    talkPose = { ...talkPose, smoothRms: 0, stamp: 0 };
    talk.style.transition = 'transform 0.18s ease-out';
    talk.style.transform = 'none';
  }

  function beginTalk(): void {
    if (talkRaf !== 0) return;
    talk.style.transition = 'none';
    talkPose = { ...talkPose, stamp: 0 };
    talkRaf = requestAnimationFrame(tickTalk);
  }

  function tickTalk(now: number): void {
    if (!ui.speaking) return;
    const rms = client?.getOutputLevel() ?? 0;
    talkPose = stepTalk(talkPose, now, rms);
    talk.style.transition = 'none';
    talk.style.transform = talkPose.transform;
    if (!ui.speaking) return;
    talkRaf = requestAnimationFrame(tickTalk);
  }

  function previewSprite(name: SpriteName): void {
    ui = adoptSprite(ui, armPreview(spriteStateOf(ui), name, Date.now()));
    armSpriteTimer();
    renderExpression();
  }

  function applyEffects(effects: readonly PetEffect[]): void {
    for (const effect of effects) {
      switch (effect.type) {
        case 'render-expression':
          if (effect.schedule) armSpriteTimer();
          renderExpression();
          break;
        case 'render-status':
          renderStatus();
          break;
        case 'poke-captions':
          scheduleCaptions(effect.render);
          break;
        case 'flash-note':
          scheduleNote(effect.durationMs);
          break;
        case 'stop-speaking':
          stopTalk();
          break;
        default: {
          const unreachable: never = effect;
          void unreachable;
        }
      }
    }
  }

  function handleClientEvent(event: VoiceClientEvent): void {
    const wasSpeaking = ui.speaking;
    const reduced = reduceClientEvent(ui, event, Date.now());
    ui = reduced.state;
    if (ui.speaking && !wasSpeaking) beginTalk();
    applyEffects(reduced.effects);
  }

  function failVoiceStart(message: string): void {
    ui = { ...ui, link: 'off' };
    stopTalk();
    ui = { ...ui, phase: 'idle', noteText: message };
    scheduleNote(NOTE_MS);
    renderExpression();
    renderStatus();
  }

  function startVoice(): void {
    if (ui.link === 'connecting') return;
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
    ui = { ...ui, link: 'connecting' };
    renderStatus();
    // start() 必须在这次点击的调用栈里进入，AudioContext.resume 才算用户手势。
    void next.start().catch((error: unknown) => {
      if (client !== next) return;
      const message = error instanceof Error ? error.message : '语音连接失败';
      failVoiceStart(message);
    });
  }

  function stopVoice(): void {
    client?.close();
    client = null;
    const wasSpeaking = ui.speaking;
    ui = { ...ui, link: 'off', phase: 'idle', speaking: false };
    if (wasSpeaking) stopTalk();
    renderExpression();
    renderStatus();
  }

  function interruptVoice(): void {
    client?.interrupt();
    if (!ui.speaking) return;
    ui = { ...ui, noteText: '已打断' };
    scheduleNote(NOTE_MS);
  }

  function handlePetClick(): void {
    img.focus({ preventScroll: true });
    if (ui.link === 'off' && client?.active !== true) {
      startVoice();
      return;
    }
    if (ui.speaking) {
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
    const decision = classifyRelease({
      gesture: current,
      cancelled,
      clientX: event.clientX,
      clientY: event.clientY,
      sizePx: prefs.sizePx,
      viewport: readViewport(),
      rightGap: prefs.rightGap,
    });
    if (decision.kind !== 'drop') {
      host.style.transition = 'none';
      host.style.left = `${current.origLeft}px`;
      host.style.top = `${current.origTop}px`;
      window.requestAnimationFrame(() => {
        host.style.transition = HOST_MOVE;
      });
      if (decision.kind === 'click') handlePetClick();
      return;
    }
    const drop = decision.drop;
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
    drag = notePointerMove(drag, event.clientX, event.clientY);
    if (!drag.moved) return;
    const pos = dragPosition(drag, event.clientX, event.clientY, prefs.sizePx, readViewport());
    host.style.left = `${pos.left}px`;
    host.style.top = `${pos.top}px`;
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

  function setStateMessage(text: string): void {
    stateMessage.textContent = text;
    stateMessage.hidden = text === '';
  }

  function renderSessions(rows: readonly SessionRow[]): void {
    sessionList.replaceChildren();
    if (rows.length === 0) {
      const empty = element('div', 'session-empty');
      empty.textContent = '没有会话';
      sessionList.append(empty);
      return;
    }
    for (const row of rows) {
      const button = element('button', 'session-btn');
      button.type = 'button';
      button.title = row.id;
      button.setAttribute('aria-pressed', row.id === boundSessionId ? 'true' : 'false');
      const title = element('span', 's-title');
      title.textContent = row.title;
      const check = element('span', 's-check');
      check.append(createCheckIcon(document));
      button.append(title, check);
      button.addEventListener('click', () => {
        void selectSession({ sessionId: row.id });
      });
      sessionList.append(button);
    }
    syncSessionButtons();
  }

  function renderState(payload: unknown): void {
    const view = projectHostState(payload);
    if (!view.known) {
      setStateMessage(view.statusText);
      if (settingsOpen) placeFloating(panel, bubbleSide);
      return;
    }
    pipelineTag.textContent = view.pipelineLabel.replace(/^管线：/u, '') || '未知';
    pipelineTag.title = view.pipelineLabel;
    boundSessionId = view.boundSessionId;
    boundId.textContent = view.boundTitle;
    boundId.title = view.boundSessionId === null
      ? view.boundLabel
      : `${view.boundTitle}（${view.boundSessionId}）`;
    setStateMessage(view.statusText);
    renderSessions(view.sessions);
    if (settingsOpen) placeFloating(panel, bubbleSide);
  }

  async function loadState(): Promise<void> {
    const ticket = ++stateTicket;
    setStateMessage('正在读取…');
    try {
      const response = await fetch('/dsh-voice/state', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload: unknown = await response.json();
      if (ticket !== stateTicket) return;
      renderState(payload);
    } catch {
      if (ticket !== stateTicket) return;
      setStateMessage('读不到会话状态');
      if (settingsOpen) placeFloating(panel, bubbleSide);
    }
  }

  async function selectSession(body: { sessionId: string } | { action: 'create' }): Promise<void> {
    if (sessionBusy) return;
    sessionBusy = true;
    syncSessionButtons();
    setStateMessage('正在切换…');
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
      setStateMessage('会话切换失败');
    } finally {
      sessionBusy = false;
      syncSessionButtons();
    }
  }

  function openSettings(): void {
    settingsOpen = true;
    panel.hidden = false;
    root.classList.add('panel-open');
    gearBtn.setAttribute('aria-pressed', 'true');
    placeFloating(panel, bubbleSide);
    void loadState();
  }

  function closeSettings(): void {
    settingsOpen = false;
    panel.hidden = true;
    root.classList.remove('panel-open');
    gearBtn.setAttribute('aria-pressed', 'false');
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
  pipelineTag.textContent = '…';
  boundId.textContent = '…';
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
    if (event.repeat || ui.link === 'off') return;
    event.preventDefault();
    interruptVoice();
  });
  img.addEventListener('touchstart', (event) => {
    event.preventDefault();
  }, { passive: false });

  bubble.addEventListener('mouseenter', () => {
    const reduced = markBubbleHover(ui, true);
    ui = reduced.state;
    applyEffects(reduced.effects);
  });
  bubble.addEventListener('mouseleave', () => {
    const reduced = markBubbleHover(ui, false);
    ui = reduced.state;
    applyEffects(reduced.effects);
  });
  hintDismiss.addEventListener('click', (event) => {
    event.stopPropagation();
    prefs.headphoneHintDismissed = true;
    ui = { ...ui, headphoneHintDismissed: true };
    savePrefs(prefs);
    renderBubble();
  });
  micBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (ui.link === 'off') startVoice();
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
    prefs.sizePx = clampSliderSize(next);
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
    ui = { ...ui, showBubble: prefs.showBubble };
    renderBubble();
    savePrefs(prefs);
  });
  for (const [name, chip] of chips) {
    chip.addEventListener('click', () => { previewSprite(name); });
  }
  exprDetails.addEventListener('toggle', () => {
    if (settingsOpen) placeFloating(panel, bubbleSide);
  });

  host.addEventListener('transitionend', (event) => {
    if (event.target !== host) return;
    placeTools();
    placeFloating(bubble, bubbleSide);
    if (settingsOpen) placeFloating(panel, bubbleSide);
  });
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
