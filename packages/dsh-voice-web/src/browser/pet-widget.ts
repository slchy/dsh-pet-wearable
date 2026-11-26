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
  CUSTOM_MODE_TIP,
  OPTIMIZED_DEFAULT_TIP,
  VOICE_MODE_LABELS,
  type AvailableModelItem,
  type FetchModelsRequest,
  type HostVoiceConfigSnapshot,
  type ModelFetchSlot,
  type VoiceConfigUpdateRequest,
  type VoiceMode,
} from '../voice-overrides.ts';
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
  type ApiKeyFieldDom,
  type ModelPickerDom,
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
import { createPetSfx } from './pet-sfx.ts';
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

/** v2 的打断原语。浏览器是 v2 设备，服务端不会再补一条 `Control: stop`。 */
function isAudioStop(json: unknown): boolean {
  return isRecord(json) && json['op'] === 'audio.stop';
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

interface VoiceConfigDraft {
  mode: VoiceMode;
  defaultApiKey: string;
  clearDefaultApiKey: boolean;
  liveBaseUrl: string;
  liveApiKey: string;
  clearLiveApiKey: boolean;
  liveModel: string;
  liveAsrModel: string;
  sttBaseUrl: string;
  sttApiKey: string;
  clearSttApiKey: boolean;
  sttModel: string;
  ttsReuseStt: boolean;
  ttsBaseUrl: string;
  ttsApiKey: string;
  clearTtsApiKey: boolean;
  ttsModel: string;
  ttsVoice: string;
}

interface SlotModelState {
  fetching: boolean;
  models: AvailableModelItem[];
  filter: string;
  status: string;
  statusTone: 'neutral' | 'ok' | 'err';
}

function emptyDraft(): VoiceConfigDraft {
  return {
    mode: 'default',
    defaultApiKey: '',
    clearDefaultApiKey: false,
    liveBaseUrl: '',
    liveApiKey: '',
    clearLiveApiKey: false,
    liveModel: '',
    liveAsrModel: '',
    sttBaseUrl: '',
    sttApiKey: '',
    clearSttApiKey: false,
    sttModel: '',
    ttsReuseStt: false,
    ttsBaseUrl: '',
    ttsApiKey: '',
    clearTtsApiKey: false,
    ttsModel: '',
    ttsVoice: '',
  };
}

function emptySlotModelState(): SlotModelState {
  return {
    fetching: false,
    models: [],
    filter: '',
    status: '',
    statusTone: 'neutral',
  };
}

function draftFromSnapshot(snap: HostVoiceConfigSnapshot): VoiceConfigDraft {
  return {
    mode: snap.mode,
    defaultApiKey: '',
    clearDefaultApiKey: false,
    liveBaseUrl: snap.live.baseUrl,
    liveApiKey: '',
    clearLiveApiKey: false,
    liveModel: snap.live.model,
    liveAsrModel: snap.live.asrModel,
    sttBaseUrl: snap.cascade.sttBaseUrl,
    sttApiKey: '',
    clearSttApiKey: false,
    sttModel: snap.cascade.sttModel,
    ttsReuseStt: snap.cascade.ttsReuseStt,
    ttsBaseUrl: snap.cascade.ttsBaseUrl,
    ttsApiKey: '',
    clearTtsApiKey: false,
    ttsModel: snap.cascade.ttsModel,
    ttsVoice: snap.cascade.ttsVoice,
  };
}

const FALLBACK_VOICE_CONFIG: HostVoiceConfigSnapshot = {
  mode: 'default',
  defaultMode: { apiKeyMasked: null, hasApiKey: false },
  live: { baseUrl: '', apiKeyMasked: null, hasApiKey: false, model: '', asrModel: '' },
  cascade: {
    sttBaseUrl: '',
    sttApiKeyMasked: null,
    hasSttApiKey: false,
    sttModel: '',
    ttsReuseStt: false,
    ttsBaseUrl: '',
    ttsApiKeyMasked: null,
    hasTtsApiKey: false,
    ttsModel: '',
    ttsVoice: '',
  },
  active: { mode: 'default', pipeline: 'live', detail: '默认优化' },
  envFileHint: '~/.dsh/.env',
  reloading: false,
};

function hasDraftChanges(draft: VoiceConfigDraft, snap: HostVoiceConfigSnapshot): boolean {
  if (draft.mode !== snap.mode) return true;
  if (draft.defaultApiKey.trim() !== '' || draft.clearDefaultApiKey) return true;
  if (draft.liveApiKey.trim() !== '' || draft.clearLiveApiKey) return true;
  if (draft.sttApiKey.trim() !== '' || draft.clearSttApiKey) return true;
  if (draft.ttsApiKey.trim() !== '' || draft.clearTtsApiKey) return true;
  if (draft.liveBaseUrl.trim() !== snap.live.baseUrl) return true;
  if (draft.liveModel.trim() !== snap.live.model) return true;
  if (draft.liveAsrModel.trim() !== snap.live.asrModel) return true;
  if (draft.sttBaseUrl.trim() !== snap.cascade.sttBaseUrl) return true;
  if (draft.sttModel.trim() !== snap.cascade.sttModel) return true;
  if (draft.ttsReuseStt !== snap.cascade.ttsReuseStt) return true;
  if (draft.ttsBaseUrl.trim() !== snap.cascade.ttsBaseUrl) return true;
  if (draft.ttsModel.trim() !== snap.cascade.ttsModel) return true;
  if (draft.ttsVoice.trim() !== snap.cascade.ttsVoice) return true;
  return false;
}

function mountNow(): void {
  const prefs = loadPrefs();
  installHostGuard();
  const {
    host, shadow, root, mirror, squish, talk, img, bubble, hint, hintDismiss,
    asrLine, asrBody, replyLine, replyLane, replyBody, badge, note,
    statusBar, statusText, tools, micBtn, muteBtn, gearBtn, panel, panelClose,
    pipelineTag, boundId, stateMessage, sessionList, createBtn,
    configSection, configDetails, configSummaryValue, configTip, configTipText, modeBtns,
    defaultPane, defaultKeyField,
    livePane, liveBaseUrlInput, liveKeyField, liveModelPicker, liveModelInput, liveAsrModelInput,
    cascadePane, cascadeSttBaseUrlInput, cascadeSttKeyField, cascadeSttPicker, cascadeSttModelInput,
    cascadeTtsReuseInput, cascadeTtsEndpointBox, cascadeTtsBaseUrlInput, cascadeTtsKeyField,
    cascadeTtsPicker, cascadeTtsModelInput, cascadeTtsVoiceInput,
    configEnvHint, configFeedback, configResetBtn, configApplyBtn,
    sizeInput, sizeReadout, mirrorInput, bubbleInput,
    soundInput, retroInput, sfxTestBtn, exprDetails, exprCurrent, chips, resetBtn,
  } = buildPetShell(document, prefs);

  let ui: PetUiState = initialPetUiState(prefs);
  let bubbleSide: 'left' | 'right' = 'left';
  let client: VoiceClient | null = null;
  // 提示音优先复用通话里的 AudioContext（浏览器 AEC 的参考信号），空闲时独立轻量。
  const sfx = createPetSfx({
    getSharedContext: () => client?.context ?? null,
    isEnabled: () => prefs.soundEnabled,
    isRetroSpark: () => prefs.retroSpark,
  });
  /** 一次通话只响一次开麦音；等语音后端 `ready` 再响，避免连上即被 4503 断开时先响一声。 */
  let micOpenCuePlayed = false;
  /** 服务端 stop 帧会先把 speaking 清掉，用一拍把「刚刚在说」接给打断音效。 */
  let speakingJustEnded = false;
  let drag: DragGesture | null = null;
  let alpha: Uint8ClampedArray | null = null;
  let hitMode: 'rect' | 'alpha' = 'rect';
  let settingsOpen = false;
  let sessionBusy = false;
  let configBusy = false;
  let configDirty = false;
  let hostStateLoaded = false;
  let autoExpandedForMissingKey = false;
  let serverVoiceConfig: HostVoiceConfigSnapshot | null = null;
  let draftConfig: VoiceConfigDraft = emptyDraft();
  const slotModels: Record<ModelFetchSlot, SlotModelState> = {
    live: emptySlotModelState(),
    stt: emptySlotModelState(),
    tts: emptySlotModelState(),
  };
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

  function syncSfxControls(): void {
    soundInput.checked = prefs.soundEnabled;
    retroInput.checked = prefs.retroSpark;
    retroInput.disabled = !prefs.soundEnabled;
    sfxTestBtn.disabled = !prefs.soundEnabled;
    retroInput.closest('.setting-row')?.classList.toggle('is-disabled', !prefs.soundEnabled);
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
    const wasLive = ui.link !== 'off';

    // 音效按「事件发生时」的口径判，再进状态机。stop 帧和它触发的 speaking=false
    // 在同一批事件里，`speakingJustEnded` 让打断音还看得到刚刚的说话态。
    if (event.type === 'call' && isAudioStop(event.json)) {
      if (wasSpeaking || speakingJustEnded) {
        sfx.play('barge-in');
        speakingJustEnded = false;
      }
    } else if (event.type === 'control' && event.text === 'stop') {
      if (wasSpeaking || speakingJustEnded) {
        sfx.play('barge-in');
        speakingJustEnded = false;
      }
    } else if (event.type === 'ready') {
      if (!micOpenCuePlayed) {
        micOpenCuePlayed = true;
        sfx.play('mic-open');
      }
    } else if (event.type === 'close') {
      if (event.code === 1000) {
        if (wasLive) sfx.play('mic-close');
      } else {
        sfx.play('sleepy');
      }
    } else if (event.type === 'speaking') {
      if (event.active) sfx.fadeOut('delegate', 20);
    } else if (event.type === 'ui') {
      if (event.event.type === 'delegated') {
        sfx.play('delegate');
      } else if (event.event.type === 'announce') {
        sfx.play('proactive');
      } else if (event.event.type === 'reply.delta' || event.event.type === 'reply.final') {
        sfx.fadeOut('delegate', 20);
      }
    }

    const reduced = reduceClientEvent(ui, event, Date.now());
    ui = reduced.state;
    if (wasSpeaking && !ui.speaking) {
      speakingJustEnded = true;
      queueMicrotask(() => { speakingJustEnded = false; });
    }
    if (ui.speaking && !wasSpeaking) beginTalk();
    applyEffects(reduced.effects);
  }

  function failVoiceStart(message: string): void {
    sfx.play('sleepy');
    ui = { ...ui, link: 'off' };
    stopTalk();
    ui = { ...ui, phase: 'idle', noteText: message };
    scheduleNote(NOTE_MS);
    renderExpression();
    renderStatus();
  }

  function startVoice(): void {
    if (ui.link === 'connecting') return;
    // 必须在这次点击的调用栈里解锁备用 AudioContext。
    sfx.prime();
    micOpenCuePlayed = false;
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
    const wasLive = ui.link !== 'off';
    client?.close();
    client = null;
    const wasSpeaking = ui.speaking;
    ui = { ...ui, link: 'off', phase: 'idle', speaking: false };
    if (wasSpeaking) stopTalk();
    renderExpression();
    renderStatus();
    if (wasLive) sfx.play('mic-close');
  }

  function interruptVoice(): void {
    // `client.interrupt()` 会同步停播放并回报 speaking=false，先记账再动手。
    const wasSpeaking = ui.speaking;
    client?.interrupt();
    if (!wasSpeaking) return;
    sfx.play('barge-in');
    // 手动打断已经响过，服务端随后下发的 audio.stop 不再补第二声。
    speakingJustEnded = false;
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

  function setConfigFeedback(text: string, tone: 'neutral' | 'ok' | 'err' = 'neutral'): void {
    configFeedback.textContent = text;
    configFeedback.hidden = text === '';
    configFeedback.className = tone === 'ok'
      ? 'config-feedback is-ok'
      : tone === 'err'
        ? 'config-feedback is-err'
        : 'config-feedback';
  }

  function syncTextInput(input: HTMLInputElement, value: string): void {
    if (shadow.activeElement !== input && input.value !== value) {
      input.value = value;
    }
    input.disabled = configBusy;
  }

  function renderApiKeyField(
    field: ApiKeyFieldDom,
    opts: {
      readonly masked: string | null;
      readonly draftValue: string;
      readonly pendingClear: boolean;
      readonly emptyPlaceholder: string;
    },
  ): void {
    const hasSaved = opts.masked !== null;
    if (opts.pendingClear) {
      field.badge.textContent = '保存后清除';
      field.badge.className = 'key-badge is-clearing';
      field.badge.title = '保存后会从 .env 删除此密钥';
      field.clearBtn.hidden = false;
      field.clearBtn.textContent = '撤销';
    } else if (hasSaved) {
      field.badge.textContent = opts.masked;
      field.badge.className = 'key-badge is-set';
      field.badge.title = `已脱敏保存于 .env：${opts.masked}`;
      field.clearBtn.hidden = false;
      field.clearBtn.textContent = '清除';
    } else {
      field.badge.textContent = '未配置';
      field.badge.className = 'key-badge';
      field.badge.title = '尚未写入 .env';
      field.clearBtn.hidden = true;
    }
    field.clearBtn.disabled = configBusy;
    syncTextInput(field.input, opts.draftValue);
    field.input.placeholder = opts.pendingClear
      ? '输入新 Key 可覆盖，留空则清除'
      : hasSaved
        ? `已保存 ${opts.masked}，留空保持不变`
        : opts.emptyPlaceholder;
  }

  function pickerDomFor(slot: ModelFetchSlot): ModelPickerDom {
    if (slot === 'live') return liveModelPicker;
    if (slot === 'stt') return cascadeSttPicker;
    return cascadeTtsPicker;
  }

  function renderModelPicker(slot: ModelFetchSlot): void {
    const dom = pickerDomFor(slot);
    const state = slotModels[slot];
    const backendReady = serverVoiceConfig !== null;
    dom.fetchBtn.disabled = configBusy || state.fetching || !backendReady;
    dom.fetchBtn.textContent = state.fetching
      ? '拉取中…'
      : slot === 'live'
        ? '拉取可用模型'
        : slot === 'stt'
          ? '拉取 STT 模型'
          : '拉取 TTS 模型';
    dom.status.textContent = state.status;
    dom.status.title = state.status;
    dom.status.className = state.statusTone === 'err'
      ? 'model-fetch-status is-err'
      : state.statusTone === 'ok'
        ? 'model-fetch-status is-ok'
        : 'model-fetch-status';

    dom.tableWrap.hidden = state.models.length === 0;
    if (state.models.length === 0) return;

    dom.filterInput.hidden = state.models.length <= 6;
    if (shadow.activeElement !== dom.filterInput && dom.filterInput.value !== state.filter) {
      dom.filterInput.value = state.filter;
    }

    const q = state.filter.trim().toLowerCase();
    const filtered = q === ''
      ? state.models
      : state.models.filter((item) => item.id.toLowerCase().includes(q)
        || (item.ownedBy?.toLowerCase().includes(q) ?? false));

    const currentPrimary = slot === 'live'
      ? draftConfig.liveModel.trim()
      : slot === 'stt'
        ? draftConfig.sttModel.trim()
        : draftConfig.ttsModel.trim();
    const currentSecondary = slot === 'live' ? draftConfig.liveAsrModel.trim() : '';

    dom.list.replaceChildren();
    if (filtered.length === 0) {
      const empty = element('div', 'model-empty');
      empty.textContent = '无匹配模型，可直接手动输入';
      dom.list.append(empty);
      return;
    }

    for (const item of filtered) {
      const row = element('div', 'model-row');
      const isPrimary = currentPrimary === item.id;
      if (isPrimary) row.classList.add('is-selected');

      const mainBtn = element('button', 'model-row-main');
      mainBtn.type = 'button';
      mainBtn.title = item.ownedBy ? `${item.id} (${item.ownedBy})` : item.id;
      const idSpan = element('span', 'model-row-id');
      idSpan.textContent = item.id;
      mainBtn.append(idSpan);
      if (item.ownedBy !== undefined && slot !== 'live') {
        const ownerSpan = element('span', 'model-row-owner');
        ownerSpan.textContent = item.ownedBy;
        mainBtn.append(ownerSpan);
      }
      mainBtn.addEventListener('click', () => {
        if (slot === 'live') updateDraftConfig({ liveModel: item.id });
        else if (slot === 'stt') updateDraftConfig({ sttModel: item.id });
        else updateDraftConfig({ ttsModel: item.id });
      });
      row.append(mainBtn);

      if (slot === 'live') {
        const altBtn = element('button', 'model-row-alt');
        altBtn.type = 'button';
        altBtn.textContent = '转写';
        altBtn.title = `将 ${item.id} 设为 Live 转写模型`;
        if (currentSecondary === item.id) altBtn.classList.add('is-selected');
        altBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          updateDraftConfig({ liveAsrModel: item.id });
        });
        row.append(altBtn);
      }

      dom.list.append(row);
    }
  }

  function renderVoiceConfig(): void {
    const backendReady = serverVoiceConfig !== null;
    const snap = serverVoiceConfig ?? FALLBACK_VOICE_CONFIG;
    configSection.hidden = false;

    configSummaryValue.textContent = !backendReady
      ? (hostStateLoaded ? '需重启后端' : '读取中…')
      : (snap.active.detail || (snap.mode === 'default' ? '默认优化' : VOICE_MODE_LABELS[snap.mode]));

    for (const [mode, btn] of modeBtns) {
      btn.setAttribute('aria-checked', draftConfig.mode === mode ? 'true' : 'false');
      btn.disabled = configBusy;
    }

    const isDefaultPane = draftConfig.mode === 'default';
    configTip.className = isDefaultPane ? 'config-tip' : 'config-tip is-subtle';
    configTipText.textContent = isDefaultPane ? OPTIMIZED_DEFAULT_TIP : CUSTOM_MODE_TIP;

    defaultPane.hidden = draftConfig.mode !== 'default';
    livePane.hidden = draftConfig.mode !== 'live';
    cascadePane.hidden = draftConfig.mode !== 'cascade';

    // 默认模式：只需 DASHSCOPE_API_KEY
    renderApiKeyField(defaultKeyField, {
      masked: snap.defaultMode.apiKeyMasked,
      draftValue: draftConfig.defaultApiKey,
      pendingClear: draftConfig.clearDefaultApiKey,
      emptyPlaceholder: '输入 DashScope API Key（sk-...）',
    });

    // Live 模式
    syncTextInput(liveBaseUrlInput, draftConfig.liveBaseUrl);
    renderApiKeyField(liveKeyField, {
      masked: snap.live.apiKeyMasked,
      draftValue: draftConfig.liveApiKey,
      pendingClear: draftConfig.clearLiveApiKey,
      emptyPlaceholder: '输入 OpenAI 兼容 API Key',
    });
    syncTextInput(liveModelInput, draftConfig.liveModel);
    syncTextInput(liveAsrModelInput, draftConfig.liveAsrModel);
    renderModelPicker('live');

    // 级联模式
    syncTextInput(cascadeSttBaseUrlInput, draftConfig.sttBaseUrl);
    renderApiKeyField(cascadeSttKeyField, {
      masked: snap.cascade.sttApiKeyMasked,
      draftValue: draftConfig.sttApiKey,
      pendingClear: draftConfig.clearSttApiKey,
      emptyPlaceholder: '输入 STT API Key',
    });
    syncTextInput(cascadeSttModelInput, draftConfig.sttModel);
    renderModelPicker('stt');

    cascadeTtsReuseInput.checked = draftConfig.ttsReuseStt;
    cascadeTtsReuseInput.disabled = configBusy;
    cascadeTtsEndpointBox.hidden = draftConfig.ttsReuseStt;
    syncTextInput(cascadeTtsBaseUrlInput, draftConfig.ttsBaseUrl);
    renderApiKeyField(cascadeTtsKeyField, {
      masked: snap.cascade.ttsApiKeyMasked,
      draftValue: draftConfig.ttsApiKey,
      pendingClear: draftConfig.clearTtsApiKey,
      emptyPlaceholder: '输入 TTS API Key',
    });
    syncTextInput(cascadeTtsModelInput, draftConfig.ttsModel);
    syncTextInput(cascadeTtsVoiceInput, draftConfig.ttsVoice);
    renderModelPicker('tts');

    configEnvHint.textContent = `保存后写入 ${snap.envFileHint}（前端仅展示脱敏密钥）`;
    if (hostStateLoaded && !backendReady) {
      setConfigFeedback('当前 dsh web 仍运行旧版插件后端，请重启 dsh web 后再写入 .env 或拉取模型。', 'err');
    }
    configDirty = hasDraftChanges(draftConfig, snap);
    configResetBtn.disabled = !backendReady || configBusy || (snap.mode === 'default' && !configDirty);
    configApplyBtn.disabled = !backendReady || configBusy || !configDirty;
    configApplyBtn.textContent = configBusy ? '正在写入并重载…' : '写入 .env 并重载';
  }

  function updateDraftConfig(patch: Partial<VoiceConfigDraft>): void {
    draftConfig = { ...draftConfig, ...patch };
    setConfigFeedback('');
    renderVoiceConfig();
    if (settingsOpen) placeFloating(panel, bubbleSide);
  }

  function buildConfigUpdatePayload(): VoiceConfigUpdateRequest {
    const mode = draftConfig.mode;
    const defaultKey = draftConfig.defaultApiKey.trim();
    const liveKey = draftConfig.liveApiKey.trim();
    const sttKey = draftConfig.sttApiKey.trim();
    const ttsKey = draftConfig.ttsApiKey.trim();

    const includeDefault = mode === 'default' || defaultKey !== '' || draftConfig.clearDefaultApiKey;
    const includeLive = mode === 'live' || liveKey !== '' || draftConfig.clearLiveApiKey;
    const includeCascade = mode === 'cascade'
      || sttKey !== ''
      || draftConfig.clearSttApiKey
      || ttsKey !== ''
      || draftConfig.clearTtsApiKey;

    return {
      mode,
      ...(includeDefault
        ? {
          defaultMode: {
            ...(draftConfig.clearDefaultApiKey
              ? { clearApiKey: true }
              : defaultKey !== ''
                ? { apiKey: defaultKey }
                : {}),
          },
        }
        : {}),
      ...(includeLive
        ? {
          live: {
            baseUrl: draftConfig.liveBaseUrl.trim(),
            model: draftConfig.liveModel.trim(),
            asrModel: draftConfig.liveAsrModel.trim(),
            ...(draftConfig.clearLiveApiKey
              ? { clearApiKey: true }
              : liveKey !== ''
                ? { apiKey: liveKey }
                : {}),
          },
        }
        : {}),
      ...(includeCascade
        ? {
          cascade: {
            sttBaseUrl: draftConfig.sttBaseUrl.trim(),
            sttModel: draftConfig.sttModel.trim(),
            ...(draftConfig.clearSttApiKey
              ? { clearSttApiKey: true }
              : sttKey !== ''
                ? { sttApiKey: sttKey }
                : {}),
            ttsReuseStt: draftConfig.ttsReuseStt,
            ttsBaseUrl: draftConfig.ttsBaseUrl.trim(),
            ttsModel: draftConfig.ttsModel.trim(),
            ttsVoice: draftConfig.ttsVoice.trim(),
            ...(draftConfig.clearTtsApiKey
              ? { clearTtsApiKey: true }
              : ttsKey !== ''
                ? { ttsApiKey: ttsKey }
                : {}),
          },
        }
        : {}),
    };
  }

  async function fetchSlotModels(slot: ModelFetchSlot): Promise<void> {
    const state = slotModels[slot];
    if (state.fetching || configBusy) return;
    state.fetching = true;
    state.status = '正在拉取 /models…';
    state.statusTone = 'neutral';
    renderModelPicker(slot);

    const body: FetchModelsRequest = slot === 'live'
      ? {
        slot: 'live',
        ...(draftConfig.liveBaseUrl.trim() === '' ? {} : { baseUrl: draftConfig.liveBaseUrl.trim() }),
        ...(draftConfig.liveApiKey.trim() === '' ? {} : { apiKey: draftConfig.liveApiKey.trim() }),
      }
      : slot === 'stt'
        ? {
          slot: 'stt',
          ...(draftConfig.sttBaseUrl.trim() === '' ? {} : { baseUrl: draftConfig.sttBaseUrl.trim() }),
          ...(draftConfig.sttApiKey.trim() === '' ? {} : { apiKey: draftConfig.sttApiKey.trim() }),
        }
        : {
          slot: 'tts',
          reuseStt: draftConfig.ttsReuseStt,
          ...(draftConfig.ttsReuseStt
            ? {
              ...(draftConfig.sttBaseUrl.trim() === '' ? {} : { sttBaseUrl: draftConfig.sttBaseUrl.trim() }),
              ...(draftConfig.sttApiKey.trim() === '' ? {} : { sttApiKey: draftConfig.sttApiKey.trim() }),
            }
            : {
              ...(draftConfig.ttsBaseUrl.trim() === '' ? {} : { baseUrl: draftConfig.ttsBaseUrl.trim() }),
              ...(draftConfig.ttsApiKey.trim() === '' ? {} : { apiKey: draftConfig.ttsApiKey.trim() }),
            }),
        };

    try {
      const response = await fetch('/dsh-voice/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !isRecord(payload) || payload['ok'] !== true || !Array.isArray(payload['models'])) {
        const errText = isRecord(payload) && typeof payload['error'] === 'string'
          ? payload['error']
          : `HTTP ${response.status}`;
        throw new Error(errText);
      }
      const parsed: AvailableModelItem[] = [];
      for (const entry of payload['models']) {
        if (!isRecord(entry) || typeof entry['id'] !== 'string') continue;
        const ownedBy = typeof entry['ownedBy'] === 'string' ? entry['ownedBy'] : undefined;
        parsed.push(ownedBy === undefined ? { id: entry['id'] } : { id: entry['id'], ownedBy });
      }
      state.models = parsed;
      state.filter = '';
      state.status = `已拉取 ${parsed.length} 个模型`;
      state.statusTone = 'ok';
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : '拉取失败';
      state.status = detail;
      state.statusTone = 'err';
    } finally {
      state.fetching = false;
      renderModelPicker(slot);
      if (settingsOpen) placeFloating(panel, bubbleSide);
    }
  }

  async function submitVoiceConfig(
    body: VoiceConfigUpdateRequest | { readonly reset: true },
    successText: string,
  ): Promise<void> {
    if (configBusy) return;
    configBusy = true;
    const hadActiveCall = ui.link !== 'off';
    if (hadActiveCall) {
      stopVoice();
    }
    setConfigFeedback('正在写入 .env 并重载语音栈…', 'neutral');
    renderVoiceConfig();
    try {
      const response = await fetch('/dsh-voice/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || (isRecord(payload) && payload['ok'] === false)) {
        const errText = isRecord(payload) && typeof payload['error'] === 'string'
          ? payload['error']
          : `HTTP ${response.status}`;
        throw new Error(errText);
      }
      configDirty = false;
      if (isRecord(payload) && isRecord(payload['state'])) {
        renderState(payload['state'], true);
        const ready = payload['state']['voiceReady'] !== false;
        if (ready) {
          setConfigFeedback(successText, 'ok');
          if (hadActiveCall) {
            ui = { ...ui, noteText: '配置已重载，点击立绘重新开启通话' };
            scheduleNote(NOTE_MS);
          }
        } else {
          const err = typeof payload['state']['voiceError'] === 'string'
            ? payload['state']['voiceError']
            : '语音栈重载未就绪';
          setConfigFeedback(`已写入 .env，但语音栈未就绪：${err}`, 'err');
        }
      } else {
        await loadState();
        setConfigFeedback(successText, 'ok');
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : '保存配置失败';
      setConfigFeedback(`保存失败：${detail}`, 'err');
    } finally {
      configBusy = false;
      renderVoiceConfig();
      if (settingsOpen) placeFloating(panel, bubbleSide);
    }
  }

  function renderState(payload: unknown, forceHydrateConfig = false): void {
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
    hostStateLoaded = true;
    serverVoiceConfig = view.voiceConfig;
    if (view.voiceConfig !== null && (forceHydrateConfig || !configDirty)) {
      draftConfig = draftFromSnapshot(view.voiceConfig);
      configDirty = false;
    }
    if (view.voiceConfig !== null) {
      setConfigFeedback('');
    }
    if (!view.voiceReady && view.voiceConfig !== null && !autoExpandedForMissingKey) {
      autoExpandedForMissingKey = true;
      configDetails.open = true;
    }
    renderVoiceConfig();
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
  syncSfxControls();
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
  soundInput.addEventListener('change', () => {
    prefs.soundEnabled = soundInput.checked;
    savePrefs(prefs);
    syncSfxControls();
    if (prefs.soundEnabled) {
      sfx.prime();
      sfx.play('mic-open');
    } else {
      sfx.fadeOut();
    }
  });
  retroInput.addEventListener('change', () => {
    prefs.retroSpark = retroInput.checked;
    savePrefs(prefs);
    if (prefs.soundEnabled) {
      sfx.prime();
      sfx.play('mic-open');
    }
  });
  sfxTestBtn.addEventListener('click', () => {
    sfx.prime();
    sfx.play('mic-open');
  });
  for (const [mode, btn] of modeBtns) {
    btn.addEventListener('click', () => {
      updateDraftConfig({ mode });
    });
  }
  defaultKeyField.input.addEventListener('input', () => {
    updateDraftConfig({ defaultApiKey: defaultKeyField.input.value, clearDefaultApiKey: false });
  });
  defaultKeyField.clearBtn.addEventListener('click', () => {
    updateDraftConfig({ clearDefaultApiKey: !draftConfig.clearDefaultApiKey, defaultApiKey: '' });
  });

  liveBaseUrlInput.addEventListener('input', () => {
    updateDraftConfig({ liveBaseUrl: liveBaseUrlInput.value });
  });
  liveKeyField.input.addEventListener('input', () => {
    updateDraftConfig({ liveApiKey: liveKeyField.input.value, clearLiveApiKey: false });
  });
  liveKeyField.clearBtn.addEventListener('click', () => {
    updateDraftConfig({ clearLiveApiKey: !draftConfig.clearLiveApiKey, liveApiKey: '' });
  });
  liveModelInput.addEventListener('input', () => {
    updateDraftConfig({ liveModel: liveModelInput.value });
  });
  liveAsrModelInput.addEventListener('input', () => {
    updateDraftConfig({ liveAsrModel: liveAsrModelInput.value });
  });
  liveModelPicker.fetchBtn.addEventListener('click', () => {
    void fetchSlotModels('live');
  });
  liveModelPicker.filterInput.addEventListener('input', () => {
    slotModels.live.filter = liveModelPicker.filterInput.value;
    renderModelPicker('live');
  });

  cascadeSttBaseUrlInput.addEventListener('input', () => {
    updateDraftConfig({ sttBaseUrl: cascadeSttBaseUrlInput.value });
  });
  cascadeSttKeyField.input.addEventListener('input', () => {
    updateDraftConfig({ sttApiKey: cascadeSttKeyField.input.value, clearSttApiKey: false });
  });
  cascadeSttKeyField.clearBtn.addEventListener('click', () => {
    updateDraftConfig({ clearSttApiKey: !draftConfig.clearSttApiKey, sttApiKey: '' });
  });
  cascadeSttModelInput.addEventListener('input', () => {
    updateDraftConfig({ sttModel: cascadeSttModelInput.value });
  });
  cascadeSttPicker.fetchBtn.addEventListener('click', () => {
    void fetchSlotModels('stt');
  });
  cascadeSttPicker.filterInput.addEventListener('input', () => {
    slotModels.stt.filter = cascadeSttPicker.filterInput.value;
    renderModelPicker('stt');
  });

  cascadeTtsReuseInput.addEventListener('change', () => {
    updateDraftConfig({ ttsReuseStt: cascadeTtsReuseInput.checked });
  });
  cascadeTtsBaseUrlInput.addEventListener('input', () => {
    updateDraftConfig({ ttsBaseUrl: cascadeTtsBaseUrlInput.value });
  });
  cascadeTtsKeyField.input.addEventListener('input', () => {
    updateDraftConfig({ ttsApiKey: cascadeTtsKeyField.input.value, clearTtsApiKey: false });
  });
  cascadeTtsKeyField.clearBtn.addEventListener('click', () => {
    updateDraftConfig({ clearTtsApiKey: !draftConfig.clearTtsApiKey, ttsApiKey: '' });
  });
  cascadeTtsModelInput.addEventListener('input', () => {
    updateDraftConfig({ ttsModel: cascadeTtsModelInput.value });
  });
  cascadeTtsVoiceInput.addEventListener('input', () => {
    updateDraftConfig({ ttsVoice: cascadeTtsVoiceInput.value });
  });
  cascadeTtsPicker.fetchBtn.addEventListener('click', () => {
    void fetchSlotModels('tts');
  });
  cascadeTtsPicker.filterInput.addEventListener('input', () => {
    slotModels.tts.filter = cascadeTtsPicker.filterInput.value;
    renderModelPicker('tts');
  });

  configResetBtn.addEventListener('click', () => {
    void submitVoiceConfig({ reset: true }, '已切换回默认优化方案并重载');
  });
  configApplyBtn.addEventListener('click', () => {
    void submitVoiceConfig(buildConfigUpdatePayload(), '已写入 .env 并重载生效');
  });
  configDetails.addEventListener('toggle', () => {
    if (settingsOpen) placeFloating(panel, bubbleSide);
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
