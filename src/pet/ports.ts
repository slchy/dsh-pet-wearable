/**
 * 宠物核心对**宿主设备**的唯一依赖面。
 *
 * <h2>通用性判据</h2>
 *
 * 新增一台设备，需要改动的文件数 **≤ 2**：一个适配器实现本文件的接口，外加一行注册。
 * 做不到就说明抽象抽错了层，而不是"设备太特殊"。
 *
 * <h2>为什么只有这几项</h2>
 *
 * 每一项都对应宠物的一条具体行为，没有一项是"将来可能用得上"：
 *
 * | 端口 | 它支撑的行为 |
 * |---|---|
 * | {@link PresencePort} | 摘下重戴要主动开口一次 |
 * | {@link BatteryPort} | 电量低就变懒，不主动找人说话 |
 * | {@link TouchPort} | 一个「招呼」手势，比喊名字轻 |
 * | {@link AudioOutPort} | 快反射：预合成短音直接下发，绕开 TTS 往返 |
 *
 * <h2>这些能力**现有两台设备都不缺**</h2>
 *
 * 小米眼镜：佩戴是 `System` id=93 查询 + id=79 上报（真机双源闭环，摘下还带
 * `Aivs` id=6 `f1=4`）；电量是 `System` id=1 查询 + id=97 推送；长按触控板是
 * `Aivs` id=10。雷鸟：`isWearing()` 一行。
 *
 * 所以端口的**可选性是为将来未知设备准备的**，不是为了给现有设备打补丁 ——
 * 别拿它当"某设备缺能力"的借口。
 *
 * 语音的上下行**不在这里**：ASR / TTS / 判停 / 打断全部在云端，设备侧只交付音频原语。
 * 理由不是洁癖 —— AR1 跑不动本地推理，245 mAh 更跑不动，而且每台设备各写一套判停
 * 会让"什么算说完了"分裂成 N 个版本。
 *
 * <h2>`null` 不是 `false`</h2>
 *
 * 设备拿不到某个状态时返回 `null`，**绝不返回一个默认值**。拿不到佩戴状态不等于没戴，
 * 拿不到电量不等于没电。核心据此走降级分支，而不是把未知当已知。
 */

/** 佩戴状态来源。设备不提供时整个字段缺省。 */
export interface PresencePort {
  /**
   * 当前是否戴着。
   *
   * @returns `true` / `false`；设备读不到时给 `null`
   */
  wearing(): boolean | null;

  /**
   * 订阅状态变化。
   *
   * 适配器必须自己去重：只在真正翻转时调用，不要把轮询结果原样转发。
   *
   * @param fn - 变化回调
   * @returns 退订函数；重复调用无副作用
   */
  onChange(fn: (wearing: boolean) => void): () => void;
}

/** 电量来源。 */
export interface BatteryPort {
  /**
   * 电量百分比。
   *
   * @returns 0..100；读不到时给 `null`
   */
  level(): Promise<number | null>;
}

/** 一个「招呼」手势：触摸、长按、双击之类，由适配器归一成一次敲击。 */
export interface TouchPort {
  /**
   * 订阅敲击。
   *
   * 各设备的可用手势不一样，适配器负责归一：
   * - 小米：长按触控板 → `Aivs` id=10 → `AivsEvent.OpenDevice`
   *   （注意它**同时会打开语音会话**，别当成纯手势用）
   * - 雷鸟：镜腿触摸
   *
   * @param fn - 每次敲击调用一次
   * @returns 退订函数
   */
  onTap(fn: () => void): () => void;
}

/** 直接下发音频的通道，供**预合成的短音**使用。 */
export interface AudioOutPort {
  /** 本设备希望的采样率；核心产出的 PCM 由适配器负责重采样。 */
  readonly sampleRate: number;

  /**
   * 播一段 PCM16 单声道。
   *
   * 用于快反射（「嗯？」「在呢」这类预合成短音）：不走 TTS、不等 agent。
   * 需要走 TTS 的完整回复**不走这里**，那是 `TtsProvider` 的事。
   *
   * @param pcm - PCM16 单声道样本
   * @returns 播放完成（或被 {@link AudioOutPort.stop} 打断）时 resolve
   */
  play(pcm: Int16Array): Promise<void>;

  /** 立刻停止播放并丢弃余下缓冲。打断必须听见就停。 */
  stop(): void;
}

/**
 * 宿主设备。
 *
 * 除 {@link PetHost.now} 外的每个端口都是**可选**的：设备不提供就走降级分支，
 * 而不是让整个宠物拒绝启动。可选性是为**将来未知设备**留的 —— 现在这两台都不缺：
 * 小米眼镜有佩戴（`System` id=93 查询 / id=79 上报）与电量（id=1 / id=97）双通路，
 * 雷鸟有 `isWearing()`。
 */
export interface PetHost {
  /** 佩戴来源；缺省时用"连接是否存活"近似 */
  readonly presence?: PresencePort;
  /** 电量来源；缺省时按"永不疲劳"处理 */
  readonly battery?: BatteryPort;
  /** 敲击来源；缺省时只剩语音入口 */
  readonly touch?: TouchPort;
  /** 快反射出口；缺省时没有反射，只能等完整 TTS */
  readonly audio?: AudioOutPort;

  /**
   * 单调时钟（毫秒）。**必填**，测试要能注入。
   *
   * 用 `performance.now()` 一类的单调源，不要用 `Date.now()`：
   * 系统改时间会让"闲置了多久"直接跳变。
   */
  readonly now: () => number;
}
