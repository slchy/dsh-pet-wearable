/**
 * 宿主 `/dsh-voice/state` 的投影。
 *
 * `voiceReady === false` 才是未就绪；字段缺失或其它值都不算。
 * 标题优先 `displayTitle`，其次顶层 `title`，再读 dsh 真实的
 * `projections.values.title`（以及 `projections.title`）；空白会话退回「新会话」，最后退回 id。
 * id 优先 `sessionId`，没有再看 `id`。
 */

import {
  VOICE_MODES,
  type HostVoiceConfigSnapshot,
  type VoiceMode,
} from '../voice-overrides.ts';

export interface SessionRow {
  readonly id: string;
  readonly title: string;
}

export interface HostProjection {
  readonly known: boolean;
  readonly pipelineLabel: string;
  readonly boundSessionId: string | null;
  readonly boundLabel: string;
  /** 底栏展示用的当前会话标题（命中会话列表时取标题，否则退回 id / 未绑定）。 */
  readonly boundTitle: string;
  readonly sessions: readonly SessionRow[];
  readonly statusText: string;
  readonly voiceReady: boolean;
  /** 宿主下发的语音引擎配置快照（含脱敏密钥预览；老版本宿主缺席时为 null）。 */
  readonly voiceConfig: HostVoiceConfigSnapshot | null;
}

const VOICE_NOT_READY = '请检查 ~/.dsh/.env 中的 STT/TTS 凭据';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function nullableText(value: unknown): string | null {
  const text = nonEmptyText(value);
  return text === '' ? null : text;
}

function readProjectedTitle(value: Record<string, unknown>): string {
  const projections = value['projections'];
  if (!isRecord(projections)) return '';
  const values = projections['values'];
  const raw = isRecord(values) && 'title' in values ? values['title'] : projections['title'];
  const direct = nonEmptyText(raw);
  if (direct !== '') return direct;
  if (isRecord(raw)) return nonEmptyText(raw['title']);
  return '';
}

export function readSession(value: unknown): SessionRow | null {
  if (!isRecord(value)) return null;
  const id = typeof value['sessionId'] === 'string'
    ? value['sessionId']
    : typeof value['id'] === 'string'
      ? value['id']
      : '';
  if (id === '') return null;
  const display = nonEmptyText(value['displayTitle']);
  const direct = nonEmptyText(value['title']);
  const projected = readProjectedTitle(value);
  const title = display !== ''
    ? display
    : direct !== ''
      ? direct
      : projected !== ''
        ? projected
        : value['blank'] === true
          ? '新会话'
          : id;
  return { id, title };
}

function readVoiceMode(raw: unknown): VoiceMode {
  return typeof raw === 'string' && (VOICE_MODES as readonly string[]).includes(raw)
    ? (raw as VoiceMode)
    : 'default';
}

function readVoiceConfigSnapshot(raw: unknown): HostVoiceConfigSnapshot | null {
  if (!isRecord(raw)) return null;
  const mode = readVoiceMode(raw['mode']);
  const defaultRaw = isRecord(raw['defaultMode']) ? raw['defaultMode'] : {};
  const liveRaw = isRecord(raw['live']) ? raw['live'] : {};
  const cascadeRaw = isRecord(raw['cascade']) ? raw['cascade'] : {};
  const activeRaw = isRecord(raw['active']) ? raw['active'] : {};

  const defaultMasked = nullableText(defaultRaw['apiKeyMasked']);
  const liveMasked = nullableText(liveRaw['apiKeyMasked']);
  const sttMasked = nullableText(cascadeRaw['sttApiKeyMasked']);
  const ttsMasked = nullableText(cascadeRaw['ttsApiKeyMasked']);

  return {
    mode,
    defaultMode: {
      apiKeyMasked: defaultMasked,
      hasApiKey: defaultRaw['hasApiKey'] === true || defaultMasked !== null,
    },
    live: {
      baseUrl: nonEmptyText(liveRaw['baseUrl']),
      apiKeyMasked: liveMasked,
      hasApiKey: liveRaw['hasApiKey'] === true || liveMasked !== null,
      model: nonEmptyText(liveRaw['model']),
      asrModel: nonEmptyText(liveRaw['asrModel']),
    },
    cascade: {
      sttBaseUrl: nonEmptyText(cascadeRaw['sttBaseUrl']),
      sttApiKeyMasked: sttMasked,
      hasSttApiKey: cascadeRaw['hasSttApiKey'] === true || sttMasked !== null,
      sttModel: nonEmptyText(cascadeRaw['sttModel']),
      ttsReuseStt: cascadeRaw['ttsReuseStt'] === true,
      ttsBaseUrl: nonEmptyText(cascadeRaw['ttsBaseUrl']),
      ttsApiKeyMasked: ttsMasked,
      hasTtsApiKey: cascadeRaw['hasTtsApiKey'] === true || ttsMasked !== null,
      ttsModel: nonEmptyText(cascadeRaw['ttsModel']),
      ttsVoice: nonEmptyText(cascadeRaw['ttsVoice']),
    },
    active: {
      mode: readVoiceMode(activeRaw['mode'] ?? mode),
      pipeline: nonEmptyText(activeRaw['pipeline']) || (mode === 'cascade' ? 'cascade' : 'live'),
      detail: nonEmptyText(activeRaw['detail']),
    },
    envFileHint: nonEmptyText(raw['envFileHint']) || '~/.dsh/.env',
    reloading: raw['reloading'] === true,
  };
}

export function projectHostState(payload: unknown): HostProjection {
  if (!isRecord(payload)) {
    return {
      known: false,
      pipelineLabel: '',
      boundSessionId: null,
      boundLabel: '',
      boundTitle: '',
      sessions: [],
      statusText: '读不到会话状态',
      voiceReady: false,
      voiceConfig: null,
    };
  }
  const mode = typeof payload['pipelineMode'] === 'string' ? payload['pipelineMode'] : '';
  const bound = payload['boundSessionId'];
  const boundSessionId = typeof bound === 'string' && bound !== '' ? bound : null;
  const sessions: SessionRow[] = [];
  if (Array.isArray(payload['sessions'])) {
    for (const item of payload['sessions']) {
      const row = readSession(item);
      if (row !== null) sessions.push(row);
    }
  }
  const voiceError = typeof payload['voiceError'] === 'string' && payload['voiceError'] !== ''
    ? payload['voiceError']
    : '';
  const voiceReady = payload['voiceReady'] !== false;
  const statusText = !voiceReady
    ? `语音未就绪：${voiceError || VOICE_NOT_READY}`
    : '';
  const matchedBound = boundSessionId === null
    ? null
    : sessions.find((row) => row.id === boundSessionId) ?? null;
  const boundTitle = boundSessionId === null
    ? '未绑定'
    : matchedBound?.title ?? boundSessionId;
  return {
    known: true,
    pipelineLabel: mode === '' ? '管线：未知' : `管线：${mode}`,
    boundSessionId,
    boundLabel: boundSessionId === null ? '当前会话：未绑定' : `当前会话：${boundSessionId}`,
    boundTitle,
    sessions,
    statusText,
    voiceReady,
    voiceConfig: readVoiceConfigSnapshot(payload['voiceConfig']),
  };
}
