/**
 * 宿主 `/dsh-voice/state` 的投影。
 *
 * `voiceReady === false` 才是未就绪；字段缺失或其它值都不算。
 * 标题优先 `displayTitle`，其次非空 `title`，最后退回 id。
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
  readonly sessions: readonly SessionRow[];
  readonly statusText: string;
}

const VOICE_NOT_READY = '请检查 ~/.dsh/.env 中的 STT/TTS 凭据';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function readSession(value: unknown): SessionRow | null {
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

export function projectHostState(payload: unknown): HostProjection {
  if (!isRecord(payload)) {
    return {
      known: false,
      pipelineLabel: '',
      boundSessionId: null,
      boundLabel: '',
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
  return {
    known: true,
    pipelineLabel: mode === '' ? '管线：未知' : `管线：${mode}`,
    boundSessionId,
    boundLabel: boundSessionId === null ? '当前会话：未绑定' : `当前会话：${boundSessionId}`,
    sessions,
    statusText,
  };
}
