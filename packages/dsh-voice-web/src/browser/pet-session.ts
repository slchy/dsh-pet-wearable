/**
 * 宿主 `/dsh-voice/state` 的投影。
 *
 * `voiceReady === false` 才是未就绪；字段缺失或其它值都不算。
 * 标题优先 `displayTitle`，其次顶层 `title`，再读 dsh 真实的
 * `projections.values.title`（以及 `projections.title`）；空白会话退回「新会话」，最后退回 id。
 * id 优先 `sessionId`，没有再看 `id`。
 */

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
}

const VOICE_NOT_READY = '请检查 ~/.dsh/.env 中的 STT/TTS 凭据';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed;
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
  const statusText = payload['voiceReady'] === false
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
  };
}
