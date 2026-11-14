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
import { DEFAULT_TTS_VOICE } from './mimo.ts'
import { DEFAULT_PET_TIMING, type PetTimingOptions } from './pet/pet-timing.ts'

export const name = 'pet-wearable'

/** 本插件自己创建并拥有 agent；其余关注点由 agent 组合承担。 */
export const inject = ['agents', 'sessions', 'sessionPersistence']

export interface PetConfig {
  /** 手机连上来的 TCP 监听端口 */
  port: number
  /**
   * v1 手机的型号提示（见 `src/devices/`）。
   *
   * 新协议的设备在 `Hello` 里自报能力，用不到它；v1 手机不自报，
   * 给 `xiaomi-glasses` 补上唤醒词过滤与「看清细节」档。留空 = v1 基线。
   */
  device: string
  /** TTS 音色 */
  voice: string
  /** 判停阈值：Smart Turn 概率高于此值就认为这一轮说完了 */
  turnThreshold: number
  /** 主动开口的时机参数，默认值一律偏向「宁可少说」 */
  proactive: PetTimingOptions
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

export const Config: Schema<PetConfig> = Schema.object({
  port: Schema.natural().max(65535).default(8766).description('手机连上来的 TCP 端口'),
  device: Schema.string().default('').description('v1 手机的型号提示（如 xiaomi-glasses）；自报能力的设备不用填'),
  voice: Schema.string().default(DEFAULT_TTS_VOICE).description('TTS 音色'),
  turnThreshold: Schema.percent().default(0.5).description('判停阈值，调高更不容易被判为说完'),
  proactive: ProactiveConfig,
})

export function apply(ctx: Context, config: PetConfig): void {
  const logger = ctx.logger('pet-wearable')
  logger.info('骨架就位：语音栈尚未接线')
  logger.info(`port=${config.port} device=${config.device || 'generic'} voice=${config.voice} turnThreshold=${config.turnThreshold}`)
}
