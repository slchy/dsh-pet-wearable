/**
 * dsh 插件入口（external protocol driver）。
 *
 * 0.0.1 只有骨架：把 Config 定下来、把注入声明清楚，语音栈还没接进来。
 * 接线步骤见 archive/HANDOFF.md §4.1，其中三条纪律（apply 里捕获服务 / 归属用引用比较 /
 * quiesce 幂等且先同步 cancel 再 await dispose）要等接上 agent 之后才谈得上。
 *
 * Config 的更新语义：**只有标了 `volatile()` 的字段**才是热读（dsh 的 loader 原地换引用）；
 * 普通字段变化会让 fiber dispose 后重跑 `apply` —— 监听关闭、连接断开。
 * 端口这类"改了本来就该重建"的保持普通字段，时机参数和音色应当 volatile 化。
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { checkBindSafety } from './bind-policy.ts'
import { DEFAULT_PET_TIMING, type PetTimingOptions } from './pet/pet-timing.ts'

export const name = 'pet-wearable'

/** 本插件自己创建并拥有 agent；其余关注点由 agent 组合承担。 */
export const inject = ['agents', 'sessions', 'sessionPersistence']

export interface PetConfig {
  /** 手机连上来的 TCP 监听端口 */
  port: number
  /**
   * 监听地址。默认只通本机（`127.0.0.1`），手机侧用 `adb reverse` 接进来。
   *
   * 写成非本机地址（如 `0.0.0.0`）时，`tls` 与 `auth` **必须同时配齐**，
   * 否则插件拒绝加载 —— 判据在 `src/bind-policy.ts`，与独立进程形态共用同一份。
   */
  host: string
  /** TLS 证书。两个路径要么都给，要么都不给 */
  tls: TlsConfig
  /** 设备鉴权。`tokenFile` 为空 = 不鉴权（只允许用于本机地址） */
  auth: AuthConfig
  /**
   * v1 手机的型号提示（见 `src/devices/`）。
   *
   * 新协议的设备在 `Hello` 里自报能力，用不到它；v1 手机不自报，
   * 给 `xiaomi-glasses` 补上唤醒词过滤与「看清细节」档。留空 = v1 基线。
   */
  device: string
  /**
   * TTS 音色。**留空表示用 provider 自己的默认值** —— 具体的可选音色是 provider
   * 的事，插件不该替它决定（换个 TTS 就换一套名字）。
   */
  voice: string
  /** 判停阈值：Smart Turn 概率高于此值就认为这一轮说完了 */
  turnThreshold: number
  /** 主动开口的时机参数，默认值一律偏向「宁可少说」 */
  proactive: PetTimingOptions
}

export interface TlsConfig {
  /** 私钥文件路径（PEM）。和 `certPath` 必须成对 */
  keyPath: string
  /** 证书文件路径（PEM） */
  certPath: string
}

export interface AuthConfig {
  /**
   * 每行 `token` 或 `token:deviceId` 的文件路径（`#` 开头是注释）。
   *
   * 留空 = 不鉴权。此时只能监听本机地址，绑非本机地址会被 `checkBindSafety` 拒绝。
   */
  tokenFile: string
}

/**
 * `PetTimingOptions` 的配置 schema。
 *
 * 类型直接标在 schema 上：以后给 `PetTimingOptions` 加字段，这里编译期就会红，
 * 不会出现「配置面板少了一项，运行时才发现」。
 */
const ProactiveConfig: Schema<PetTimingOptions> = Schema.object({
  greetAfterAwayMs: Schema.natural().default(DEFAULT_PET_TIMING.greetAfterAwayMs).description('离场超过多久，重戴时才打招呼'),
  chatterAfterIdleMs: Schema.natural().default(DEFAULT_PET_TIMING.chatterAfterIdleMs).description('安静多久后可以主动搭话'),
  minProactiveGapMs: Schema.natural().default(DEFAULT_PET_TIMING.minProactiveGapMs).description('两次主动开口的最小间隔'),
  quietFromHour: Schema.natural().max(23).default(DEFAULT_PET_TIMING.quietFromHour).description('深夜起点（本地小时，含）'),
  quietToHour: Schema.natural().max(23).default(DEFAULT_PET_TIMING.quietToHour).description('深夜终点（本地小时，不含）'),
  lowBatteryPercent: Schema.natural().max(100).default(DEFAULT_PET_TIMING.lowBatteryPercent).description('低于此电量就不主动开口'),
})

const TlsConfigSchema: Schema<TlsConfig> = Schema.object({
  keyPath: Schema.string().default('').description('TLS 私钥文件路径（PEM）；与 certPath 必须成对'),
  certPath: Schema.string().default('').description('TLS 证书文件路径（PEM）'),
})

const AuthConfigSchema: Schema<AuthConfig> = Schema.object({
  tokenFile: Schema.string().default('').description('设备 token 文件（每行 token 或 token:deviceId）；留空 = 不鉴权'),
})

export const Config: Schema<PetConfig> = Schema.object({
  port: Schema.natural().max(65535).default(8766).description('手机连上来的 TCP 端口'),
  host: Schema.string().default('127.0.0.1').description('监听地址；非本机地址要求 tls 与 auth 同时配齐'),
  tls: TlsConfigSchema,
  auth: AuthConfigSchema,
  device: Schema.string().default('').description('v1 手机的型号提示（如 xiaomi-glasses）；自报能力的设备不用填'),
  voice: Schema.string().default('').description('TTS 音色；留空 = 用 provider 自己的默认值'),
  turnThreshold: Schema.percent().default(0.5).description('判停阈值，调高更不容易被判为说完'),
  proactive: ProactiveConfig,
})

export function apply(ctx: Context, config: PetConfig): void {
  const logger = ctx.logger('pet-wearable')

  // 配置一写错就在这里报，不必等接上设备、真去 bind 了才发现。
  // 判据与 `transport.ts` 共用 `src/bind-policy.ts`，不会漂。
  const hasTls = config.tls.keyPath !== '' && config.tls.certPath !== '';
  if (!hasTls && (config.tls.keyPath !== '' || config.tls.certPath !== '')) {
    throw new Error('pet-wearable: tls.keyPath 与 tls.certPath 必须成对给，只给一半等于把连接降级成明文')
  }
  const safety = checkBindSafety({
    host: config.host,
    hasTls,
    hasAuth: config.auth.tokenFile !== '',
  })
  if (!safety.ok) {
    throw new Error(`pet-wearable: ${safety.message}`)
  }

  logger.info('骨架就位：语音栈尚未接线')
  logger.info(`port=${config.port} host=${config.host} device=${config.device || 'generic'} voice=${config.voice} turnThreshold=${config.turnThreshold}`)
}
