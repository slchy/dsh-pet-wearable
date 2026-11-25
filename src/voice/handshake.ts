/**
 * 先定这条连接说哪个版本，再建业务对象。
 *
 * 能力决定了上行解码、判定核和收件箱，必须在它们构造之前就知道。
 * 连接对象由调用方注入：没配鉴权时这条函数会空等 {@link HANDSHAKE_WAIT_MS}，
 * 单测不必为了看降级去把整条 `VoiceConnection` 拉起来。
 */
import {
  resolveDeviceLink,
  V2_WELCOME,
  type DeviceLink,
} from '../devices/index.ts';
import type { Connection, HelloInfo } from '../transport.ts';
import type { VoiceConnection } from './connection.ts';
import type { VoiceService, VoiceSessionOptions } from './session-options.ts';

/**
 * 没配鉴权时等 `Hello` 的上限。v1 手机不鉴权就不发 `Hello`，
 * 这么久没动静（或先来了别的帧）就按 v1 走。
 */
export const HANDSHAKE_WAIT_MS = 1_000;

/** 握手决定版本之后，由服务把这条连接造出来。 */
export type VoiceConnectionFactory = (
  conn: Connection,
  options: VoiceSessionOptions,
  link: DeviceLink,
  service: VoiceService,
) => VoiceConnection;

/**
 * 先定这条连接说哪个版本，再建业务对象。
 *
 * - 配了鉴权：连接层保证 `Hello` 先到，等它
 * - 没配鉴权：`Hello` 先到就用它；先到的是别的帧或等满 {@link HANDSHAKE_WAIT_MS} → v1，
 *   那一帧原样转交，不丢
 */
export function handshake(
  conn: Connection,
  options: VoiceSessionOptions,
  service: VoiceService,
  create: VoiceConnectionFactory,
): void {
  let decided = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const decide = (hello: HelloInfo | null, first?: { type: number; payload: Buffer }): void => {
    if (decided) {
      return;
    }
    decided = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const link = resolveDeviceLink(hello, options.device);
    if (link.proto === 2) {
      conn.sendWelcome(V2_WELCOME);
    } else if (hello?.proto !== undefined && hello.proto >= 2) {
      console.log('  握手    设备要 v2 但能力不合法 → 不回 Welcome，按 v1 走');
    }
    const next = create(conn, options, link, service);
    // **单活**：同一时间只服务一台设备。新连接握手完成就顶掉旧的 ——
    // 手机重启 / 换机之后旧连接往往还挂着（对端已死，这边还没察觉），
    // 两条连接同时跑会让 ASR/TTS/播报互相抢，人也分不清声音来自哪一台。
    const previous = service.activeSlot.current;
    if (previous !== null) {
      console.log(`  连接    新连接接管（${conn.remote}）→ 主动断开旧连接`);
      previous.evict();
    }
    service.activeSlot.current = next;
    next.start(first, hello?.resumed === true);
  };

  conn.bind({
    onHello: (hello) => { decide(hello); },
    onFrame: (type, payload) => { decide(null, { type, payload }); },
    onClose: () => {
      decided = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  });
  if (options.authenticate === undefined) {
    timer = setTimeout(() => { decide(null); }, HANDSHAKE_WAIT_MS);
  }
}

/**
 * 把宿主给的静态上下文收成 `OmniShadow` 认的形状。
 *
 * 记忆可以是函数：每条连接构造影子时调用一次，取当时的 MEMORY.md 摘要。
 * 日期函数不在这里调用，影子自己在 `session.update` 里调用一次。
 * 空白字段不传，避免空块写进提示词或 ASR 配置。
 */
export function omniStaticContext(
  shadow: NonNullable<VoiceSessionOptions['omniShadow']>,
): {
  readonly memoryContext?: string;
  readonly clockContext?: () => string;
  readonly asrCorpusText?: string;
  readonly asrLanguage?: string;
} {
  const rawMemory = shadow.memoryContext === undefined
    ? undefined
    : (typeof shadow.memoryContext === 'function' ? shadow.memoryContext() : shadow.memoryContext);
  const memory = textIfPresent(rawMemory);
  const corpus = textIfPresent(shadow.asrCorpusText);
  const language = textIfPresent(shadow.asrLanguage);
  return {
    ...(memory === undefined ? {} : { memoryContext: memory }),
    ...(shadow.clockContext === undefined ? {} : { clockContext: shadow.clockContext }),
    ...(corpus === undefined ? {} : { asrCorpusText: corpus }),
    ...(language === undefined ? {} : { asrLanguage: language }),
  };
}

/** 空白不当事实。有内容则原样返回，不改写。 */
function textIfPresent(text: string | undefined): string | undefined {
  if (text === undefined || text.trim() === '') {
    return undefined;
  }
  return text;
}
