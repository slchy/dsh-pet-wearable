/**
 * dsh 插件入口（external protocol driver）。
 *
 * 0.0.1 只有骨架：把 Config 定下来、把注入声明清楚，语音栈还没接进来。
 * 接线步骤见 HANDOFF.md §4.1，其中三条纪律（apply 里捕获服务 / 归属用引用比较 /
 * quiesce 幂等且先同步 cancel 再 await dispose）要等接上 agent 之后才谈得上。
 *
 * Config 走 dsh 的运行时热更新：改参数不必重启，cordis 会重跑 apply。
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_TTS_VOICE } from './mimo.ts'
import { DEFAULT_PET_TIMING } from './pet/pet-timing.ts'

export const name = 'pet-wearable'

/** 本插件自己创建并拥有 agent；其余关注点由 agent 组合承担。 */
export const inject = ['agents', 'sessions', 'sessionPersistence']

export interface PetConfig {
  /** 手机连上来的 TCP 监听端口 */
  port: number
  /** TTS 音色 */
  voice: string
  /** 判停阈值：Smart Turn 概率高于此值就认为这一轮说完了 */
  turnThreshold: number
  /** 主动开口的时机参数，默认值一律偏向「宁可少说」 */
  proactive: {
    greetAfterAwayMs: number
    chatterAfterIdleMs: number
    minProactiveGapMs: number
    quietFromHour: number
    quietToHour: number
    lowBatteryPercent: number
  }
}

export const Config: Schema<PetConfig> = Schema.object({
  port: Schema.natural().max(65535).default(8766).description('手机连上来的 TCP 端口'),
  voice: Schema.string().default(DEFAULT_TTS_VOICE).description('TTS 音色'),
  turnThreshold: Schema.percent().default(0.5).description('判停阈值，调高更不容易被判为说完'),
  proactive: Schema.object({
    greetAfterAwayMs: Schema.natural().default(DEFAULT_PET_TIMING.greetAfterAwayMs).description('离场超过多久，重戴时才打招呼'),
    chatterAfterIdleMs: Schema.natural().default(DEFAULT_PET_TIMING.chatterAfterIdleMs).description('安静多久后可以主动搭话'),
    minProactiveGapMs: Schema.natural().default(DEFAULT_PET_TIMING.minProactiveGapMs).description('两次主动开口的最小间隔'),
    quietFromHour: Schema.natural().max(23).default(DEFAULT_PET_TIMING.quietFromHour).description('深夜起点（本地小时，含）'),
    quietToHour: Schema.natural().max(23).default(DEFAULT_PET_TIMING.quietToHour).description('深夜终点（本地小时，不含）'),
    lowBatteryPercent: Schema.natural().max(100).default(DEFAULT_PET_TIMING.lowBatteryPercent).description('低于此电量就不主动开口'),
  }),
})

export function apply(ctx: Context, config: PetConfig): void {
  const logger = ctx.logger('pet-wearable')
  logger.info('骨架就位：语音栈尚未接线，见 HANDOFF.md §4.1')
  logger.info(`port=${config.port} voice=${config.voice} turnThreshold=${config.turnThreshold}`)
}
