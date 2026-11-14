/**
 * 设备原语：插件的两个环**真正消费**的设备能力，仅此而已。
 *
 * - 对话环：上行音频 → 判停 → agent → 下行音频；插话即停
 * - 宠物环：佩戴 / 电量 / 招呼 → 时机 → 主动开口（含「看你所看」的主动拍照）→ 开麦听回应
 *
 * <h2>边界</h2>
 *
 * 这里只放插件自己要用的东西。设备怎么做到（P2P、相册、快门、蓝牙会话、编解码细节、
 * 显示屏、更多手势）是**设备侧**的事，交给手机端或用户自己的适配器。
 * 判据：一项原语如果说不出是哪个环的哪一步在用它，就不该在这里。
 *
 * 回声消除不在原语里：主流智能眼镜都在端侧做 AEC，插件默认设备已处理。
 *
 * <h2>形状</h2>
 *
 * | 方向 | 内容 |
 * |---|---|
 * | 上行媒体 | 音频帧；图像帧（带请求 id，或 `null` = 用户自己拍的） |
 * | 上行事件 | {@link DeviceEvent} |
 * | 下行媒体 | 音频帧（PCM16 单声道） |
 * | 下行操作 | {@link DeviceCall} |
 * | 能力 | {@link DeviceCapabilities}：设备在 `Hello` 里自报；缺省的一律按「没有」 |
 */

// ---------------------------------------------------------------- 能力

/** 上行音频编码。采样率固定 16 kHz 单声道。 */
export type AudioCodec = 'msbc' | 'pcm16';

/**
 * 拍照意图。按**用途**分，不按分辨率分：
 *
 * - `glance`：看一眼（主动拍照、识图轮用它）
 * - `detail`：看清细节（读字、看小东西）
 *
 * 同一个意图在不同设备上的实现完全不同（小米 `detail` 要按快门，雷鸟直接拍），
 * 插件只关心 {@link CaptureMode.needsUser}。
 */
export type CaptureIntent = 'glance' | 'detail';

export interface CaptureMode {
  /**
   * 这一档要不要用户在设备上动手（比如按快门）。
   *
   * 决定两件事：要等多久；**能不能主动拍** —— 要用户动手的档位不能用于主动拍照。
   */
  readonly needsUser: boolean;
}

export interface DeviceCapabilities {
  /** 上行音频编码 */
  readonly audioIn: AudioCodec;
  /** 支持的拍照意图；缺省的意图 = 不能拍 */
  readonly capture: Readonly<Partial<Record<CaptureIntent, CaptureMode>>>;
  /** 会上报 `presence`（摘下 / 重戴） */
  readonly presence: boolean;
  /** 会上报 `power`（电量） */
  readonly power: boolean;
  /** 会上报 `summon`（「招呼」手势，适配器把长按 / 单击之类归一成这一种） */
  readonly summon: boolean;
  /** 插件能用 `listen.start` 主动开麦（宠物说完一句要听你回应） */
  readonly listenStart: boolean;
  /** 会上报 `played`（下行音频真正播完）；没有就由插件按时长估算 */
  readonly played: boolean;
  /** ASR 会把这些整句识别出来但它们不是对话（固件唤醒词），照单丢弃 */
  readonly ignorePhrases: readonly string[];
}

// ---------------------------------------------------------------- 操作（下行）

/** 插件 → 设备。固定这几个动词；设备差异只能落在参数里。 */
export type DeviceCall =
  /** 立刻停止播放并清空播放队列（插话） */
  | { readonly op: 'audio.stop' }
  /** 开麦，最多听这么久（宠物环：主动开口之后听回应） */
  | { readonly op: 'listen.start'; readonly maxMs: number }
  /** 停止采集，但别断会话 —— 告别语还要播完 */
  | { readonly op: 'listen.stop' }
  /** 拍一张；结果是带同一个 `id` 的图像帧，或一条 `capture.failed` */
  | {
    readonly op: 'capture';
    readonly id: string;
    readonly intent: CaptureIntent;
    /** 设备应早于这个预算给出结果；插件自己的计时器只是兜底 */
    readonly deadlineMs: number;
  }
  /** 不要那张图了，尽快释放设备侧资源 */
  | { readonly op: 'capture.cancel'; readonly id: string }
  /** 收尾并断开 */
  | { readonly op: 'session.end' };

export type DeviceOp = DeviceCall['op'];

// ---------------------------------------------------------------- 事件（上行）

/** 拍照失败码。设备细节不进码，进 `say`。 */
export type CaptureErrorCode = 'unsupported' | 'busy' | 'timeout' | 'cancelled' | 'failed';

/** 一次拍照失败：判定看 `code`，措辞看 `say`。 */
export interface CaptureFailure {
  readonly code: CaptureErrorCode;
  /**
   * 设备给的一句**原因**，人话，插件会转述给用户。
   *
   * 「没按快门」「相册通道没建起来」这种只有设备知道的区别放在这里，
   * 插件不必认识每台设备的失败原因。
   */
  readonly say?: string;
}

/** 设备 → 插件。时间由插件在收到时自己打（设备时钟不可比）。 */
export type DeviceEvent =
  | { readonly kind: 'presence'; readonly wearing: boolean | null }
  | { readonly kind: 'power'; readonly percent: number | null; readonly charging: boolean | null }
  | { readonly kind: 'summon' }
  /** 下行音频的播放队列已经播空 */
  | { readonly kind: 'played' }
  /** 这次拍照在等用户动手；`say` 是设备给的一句提示，插件照念 */
  | { readonly kind: 'capture.waiting'; readonly id: string; readonly say?: string }
  | ({ readonly kind: 'capture.failed'; readonly id: string } & CaptureFailure);

// ---------------------------------------------------------------- 查询

/** 某个意图的拍照方式；设备不支持时为 `null`。 */
export function captureMode(caps: DeviceCapabilities, intent: CaptureIntent): CaptureMode | null {
  return caps.capture[intent] ?? null;
}

/** 能否**主动**拍这一档：要用户动手的档位不算。 */
export function canCaptureUnprompted(caps: DeviceCapabilities, intent: CaptureIntent): boolean {
  return captureMode(caps, intent)?.needsUser === false;
}

/**
 * 这个操作能否下发给该设备。
 *
 * `audio.stop` / `listen.stop` / `session.end` / `capture.cancel` 是协议基线，
 * 任何设备都必须认；其余看能力。
 */
export function supportsCall(caps: DeviceCapabilities, call: DeviceCall): boolean {
  switch (call.op) {
    case 'audio.stop':
    case 'listen.stop':
    case 'session.end':
    case 'capture.cancel':
      return true;
    case 'listen.start':
      return caps.listenStart;
    case 'capture':
      return captureMode(caps, call.intent) !== null;
  }
}
// ---------------------------------------------------------------- Hello 自报

function parseMode(value: unknown): CaptureMode | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const needsUser = (value as Record<string, unknown>)['needsUser'];
  return typeof needsUser === 'boolean' ? { needsUser } : undefined;
}

/**
 * 解析设备在 `Hello.capabilities` 里自报的能力。
 *
 * ```json
 * { "audioIn": "pcm16",
 *   "capture": { "glance": { "needsUser": false }, "detail": { "needsUser": false } },
 *   "presence": true, "power": true, "summon": true,
 *   "listenStart": true, "played": true, "ignorePhrases": [] }
 * ```
 *
 * - 缺 `audioIn` 或值不认识 → 返回 `null`：连音频都说不清，调用方该走 v1 兜底
 * - 其余字段缺省或类型不对 → 按「没有」处理，**不猜**
 * - 未知字段忽略：老插件读新设备不会崩
 */
export function parseCapabilities(raw: unknown): DeviceCapabilities | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const audioIn = record['audioIn'];
  if (audioIn !== 'msbc' && audioIn !== 'pcm16') {
    return null;
  }

  const capture: Partial<Record<CaptureIntent, CaptureMode>> = {};
  const rawCapture = record['capture'];
  if (rawCapture !== null && typeof rawCapture === 'object') {
    for (const intent of ['glance', 'detail'] as const) {
      const mode = parseMode((rawCapture as Record<string, unknown>)[intent]);
      if (mode !== undefined) {
        capture[intent] = mode;
      }
    }
  }

  const flag = (key: string): boolean => record[key] === true;
  const phrases = record['ignorePhrases'];

  return {
    audioIn,
    capture,
    presence: flag('presence'),
    power: flag('power'),
    summon: flag('summon'),
    listenStart: flag('listenStart'),
    played: flag('played'),
    ignorePhrases: Array.isArray(phrases)
      ? phrases.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      : [],
  };
}
