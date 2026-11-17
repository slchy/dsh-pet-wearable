/**
 * dsh 插件入口（web 兼容层）。
 *
 * 0.0.x 只有骨架：把 Config 定下来，WebSocket 桥与浏览器侧的采集/播放还没接进来。
 * 桥的形态是一帧一帧的 `[type:u8][length:u32 LE][payload]`，与真机那条 TCP 链路共用
 * 同一份协议层；浏览器不用 WebRTC，因为只是把一个已解码的音频流搬过去，
 * 换来的是实现简单、调试可读，代价是没有原生 AEC。
 *
 * Config 的更新语义与 `dsh-pet-wearable` 一致：标了 `volatile()` 的字段才热读，
 * 其余字段变化会让 fiber dispose 后重跑 `apply` —— 端口这类改了本来就该重建。
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'voice-web'

export interface VoiceWebConfig {
  /**
   * WS 桥监听端口。与真机那条 TCP 口分开：一个给眼镜、一个给浏览器，
   * 两者的上行编解码不同（真机 mSBC，浏览器 PCM16），混在一个口上要靠握手猜，不划算。
   */
  port: number
  /**
   * 监听地址。默认只通本机，前面挂反向代理再对外。
   *
   * 写成非本机地址时必须同时把 TLS 和页面来源白名单配齐，否则等于让任意网页
   * 接上来推流 —— 判据接桥时补在 `bind-policy` 同款的位置上。
   */
  host: string
}

export const Config: Schema<VoiceWebConfig> = Schema.object({
  port: Schema.natural().max(65535).default(8767).description('WS 桥监听端口'),
  host: Schema.string().default('127.0.0.1').description('监听地址；非本机地址要求 TLS 与来源白名单同时配齐'),
})

export function apply(ctx: Context, config: VoiceWebConfig): void {
  const logger = ctx.logger('voice-web')

  logger.info('骨架就位：WS 桥尚未接线')
  logger.info(`port=${config.port} host=${config.host}`)
}
