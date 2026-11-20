/**
 * 什么时候开口 —— 宠物核心的时机状态机。
 *
 * 纯逻辑：不碰 socket、定时器、音频设备。时间和日期全部由调用方注入
 * （{@link PetSnapshot}），所以每条规则都能用「喂一个快照，断言一个动作」单测。
 *
 * <h2>为什么单独一个文件</h2>
 *
 * 这是宠物和「语音助手」唯一真正的行为分歧：助手等你叫，宠物会自己决定。
 * 而「自己决定」最容易做成烦人的东西 —— 所以这里每条规则都在**抑制**开口：
 *
 * - 离场回来才打招呼，不是每次戴上都说
 * - 闲置足够久才搭话，且每次搭完重新计时
 * - 深夜不搭话（回来打招呼照旧）
 * - 电量低不搭话
 * - 刚聊完不急着搭话（最小间隔）
 *
 * <h2>刻意不做的两件事</h2>
 *
 * - **不决定要不要开麦。**「主动听」是能力不是时机（`EXPERIMENTS.md` §42），
 *   但它比"主动说"更侵入：开麦占着麦克风和电量，条件还没想清楚。
 *   所以本模块只给"该说话了"的信号，开麦由调用方按自己的策略决定。
 * - **不排队。** 一次 tick 至多一个动作；错过的机会下个 tick 再判。
 */

/** 时机参数。全部可覆盖，默认值都是「宁可少说」的方向。 */
export interface PetTimingOptions {
  /** 离场超过多久，重戴时才值得打招呼（ms）。太短会显得黏 */
  readonly greetAfterAwayMs: number;
  /** 安静多久后可以主动搭话（ms） */
  readonly chatterAfterIdleMs: number;
  /** 两次主动开口的最小间隔（ms），防止连续搭话 */
  readonly minProactiveGapMs: number;
  /** 深夜起点（本地小时，含）。跨零点用 `from > to` 表示 */
  readonly quietFromHour: number;
  /** 深夜终点（本地小时，不含） */
  readonly quietToHour: number;
  /** 电量低于此值就不主动开口（%）。读不到电量时不受限 */
  readonly lowBatteryPercent: number;
}

/**
 * 默认参数。
 *
 * 想更活泼应该去调 {@link PetTimingOptions.chatterAfterIdleMs}，
 * **不要加新规则** —— 规则越多越难解释它为什么沉默。
 */
export const DEFAULT_PET_TIMING: PetTimingOptions = {
  /**
   * 设计意图：离场 5 分钟后重戴才打招呼。
   *
   * **线上 `.env` 现在是 `PET_GREET_AWAY_MS=3000`**（便于观察），但那里也写着
   * 「测完改回」，而且 `pet-timing.test.ts` 有一条测试守「默认参数是宁可少说的一侧」
   * （`>= 3 min`）。这条默认值不进代码 —— 它是**观察期的临时覆盖**。
   */
  greetAfterAwayMs: 5 * 60_000,
  /** 设计意图 20 分钟。线上 `PET_CHATTER_IDLE_MS=180000` 同理是观察值，见上。 */
  chatterAfterIdleMs: 20 * 60_000,
  minProactiveGapMs: 10 * 60_000,
  quietFromHour: 23,
  quietToHour: 7,
  lowBatteryPercent: 20,
};

/** 一次判定的输入快照。 */
export interface PetSnapshot {
  /**
   * 当前是否戴着。
   *
   * `null` = 设备读不到。**不要**拿 `false` 冒充 `null`：那会把「不知道」
   * 当成「摘下了」，白白丢掉打招呼的机会。
   */
  readonly wearing: boolean | null;
  /**
   * 电量百分比；`null` = 读不到（按「不累」处理，不编造疲劳）。
   *
   * 这是**同步快照**：宿主用 `BatteryCache` 把异步的 `BatteryPort.level()`
   * 缓存成这个值（默认 60 s 一轮），核心自己不做异步。
   */
  readonly battery: number | null;
  /** 单调时钟（ms）。不要用 `Date.now()`，改系统时间会让闲置时长跳变 */
  readonly nowMs: number;
  /** 本地小时 0–23，用于深夜判定 */
  readonly localHour: number;
}

/** 时机状态机给出的动作。 */
export type PetMove =
  /** 什么都不做 —— 绝大多数 tick 都是这个 */
  | { readonly kind: 'idle' }
  /** 离场归来：值得说一句 */
  | { readonly kind: 'greet'; readonly awayMs: number }
  /** 闲置太久：可以搭一句话 */
  | { readonly kind: 'chatter'; readonly idleMs: number }
  /** 快反射：播一段**预合成**的短音（「嗯？」「在呢」），不走 TTS */
  | { readonly kind: 'reflect'; readonly cue: ReflexCue };

/** 预合成短音的编号。具体音频由宿主按 `AudioOutPort` 提供。 */
export type ReflexCue = 'tap-ack';

/**
 * 一次敲击的语义。
 *
 * 有些设备把「敲一下」和「开语音会话」绑在同一个手势上（小米长按触控板），
 * 这时敲击本身**不能**当成用户说了话，否则会话和时机机会各记一次。
 */
export interface TapInfo {
  /** 这次敲击在设备上同时打开了语音会话 */
  readonly opensSession: boolean;
}

/** 深夜判定：支持跨零点区间（`from > to`）。 */
function inQuietHours(hour: number, from: number, to: number): boolean {
  const h = ((hour % 24) + 24) % 24;
  // 23 → 7 这类跨零点区间若写成 `h >= from && h < to` 会恒为假
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

/**
 * 时机状态机。
 *
 * > **已被 `pet/brain/` 取代**（ADR-0001）。保留它是为了给 `PetBrain` 的重放测试
 * > 当行为基准（`tests/pet-brain.test.ts` 逐条对照本模块的用例），以及给不走
 * > 完整宠物环的宿主当轻量替代。生产连接用的是 `PetSession`。
 *
 * 外部事件（佩戴变化、用户说完话、敲击）调对应 `on*`；心跳调 {@link tick} 取动作。
 *
 * **佩戴变化请用 {@link onPresence} 报告。** {@link tick} 里的自动同步只为
 * 「只喂快照」的简单调用方兜底 —— 它看不见两次 tick 之间的来回翻转。
 */
export class PetTiming {
  private readonly options: PetTimingOptions;
  /** 最近一次已知的佩戴状态；`null` = 还没收到过 */
  private wearing: boolean | null = null;
  /** 开始「不戴」的单调时刻；戴着或未知时为 `null` */
  private awaySinceMs: number | null = null;
  /** 闲置计时起点 */
  private idleSinceMs = 0;
  /** 最近一次主动开口的时刻；`-Infinity` = 本进程内还没说过 */
  private lastProactiveMs = Number.NEGATIVE_INFINITY;
  /** 这一次「回来」是否已经处理过（防止同一次重戴反复打招呼） */
  private returnHandled = false;

  constructor(options: Partial<PetTimingOptions> = {}) {
    this.options = { ...DEFAULT_PET_TIMING, ...options };
  }

  /** 当前参数（只读；调试与测试用）。 */
  get config(): PetTimingOptions {
    return this.options;
  }

  /**
   * 佩戴状态变化。只在**真正翻转**时产生效果，重复喂同一个值无副作用。
   *
   * `null`（读不到）是第三种状态，不是 `false` 的别名：
   * - 已知没戴 → 读不到：**清掉离场计时**，之后即使读到戴着也不补打招呼
   * - 读不到 → 戴着：没有已知离场，不打招呼
   *
   * @param wearing - `true` / `false` / `null`
   * @param nowMs - 同一时刻的单调时钟
   */
  onPresence(wearing: boolean | null, nowMs: number): void {
    const prev = this.wearing;
    this.wearing = wearing;

    if (wearing === false) {
      if (prev !== false) {
        // 进入已知离场：开始计时，并允许回来时打招呼
        this.awaySinceMs = nowMs;
        this.returnHandled = false;
      }
      return;
    }

    if (wearing === null) {
      // 未知不等于已知：任何未消费的「离场归来」都必须作废 ——
      // 否则接下来读到 true 时，会拿一段不知道发生了什么的时间当「离开够久」。
      if (prev === false) {
        // 未知按在场处理：闲置从此刻重新计
        this.idleSinceMs = nowMs;
      }
      this.awaySinceMs = null;
      this.returnHandled = true;
      return;
    }

    // wearing === true
    if (prev === true) {
      return;
    }
    this.idleSinceMs = nowMs;
    if (prev === false) {
      // 已知离场后回来：awaySinceMs 保留，交给 tick 判断够不够久
      this.returnHandled = false;
      return;
    }
    // prev === null：上一段是「不知道」，不能当成离开过
    this.awaySinceMs = null;
    this.returnHandled = true;
  }

  /** 用户刚说过话：重置闲置，并刷新主动开口的最小间隔（刚聊完别急着搭话）。 */
  onUserSpoke(nowMs: number): void {
    this.idleSinceMs = nowMs;
    this.lastProactiveMs = nowMs;
  }

  /**
   * 一次敲击。
   *
   * - 普通敲击 = 用户主动找它：刷新闲置，并给一个快反射动作
   * - `opensSession` 的敲击（小米长按触控板）= 设备正在开麦，
   *   **不当作说话、也不给反射** —— 真正的发言随后由 {@link onUserSpoke} 报告，
   *   会话自己的应答也不该被宠物的短音盖住
   */
  onTap(nowMs: number, tap: TapInfo = { opensSession: false }): PetMove {
    if (tap.opensSession) {
      return { kind: 'idle' };
    }
    this.onUserSpoke(nowMs);
    return { kind: 'reflect', cue: 'tap-ack' };
  }

  /** 记录一次主动开口已被采纳，避免同一条件反复触发。 */
  private markProactive(nowMs: number): void {
    this.lastProactiveMs = nowMs;
    this.idleSinceMs = nowMs;
  }

  /**
   * 判一次。
   *
   * @param snap - 当前快照
   * @returns 至多一个动作；没有理由开口时给 `{ kind: 'idle' }`
   */
  tick(snap: PetSnapshot): PetMove {
    // 调用方没走 onPresence 时兜底同步（并发翻转看不到，故建议用 onPresence）
    if (snap.wearing !== this.wearing) {
      this.onPresence(snap.wearing, snap.nowMs);
    }

    // 明确没戴 → 什么都不做。`null`（读不到）按在场处理：未知不等于离场。
    if (this.wearing === false) {
      return { kind: 'idle' };
    }

    // 离场归来：只在回来后的第一次 tick 判一次，之后由 returnHandled 挡住。
    // 打招呼不受深夜 / 电量限制 —— 回来第一句比「不打扰」重要。
    if (!this.returnHandled && this.awaySinceMs !== null) {
      const awayMs = snap.nowMs - this.awaySinceMs;
      this.awaySinceMs = null;
      this.returnHandled = true;
      if (awayMs >= this.options.greetAfterAwayMs) {
        this.markProactive(snap.nowMs);
        return { kind: 'greet', awayMs };
      }
      // 离开得不久（擦了下眼镜）：当作一直在，重置闲置
      this.idleSinceMs = snap.nowMs;
      return { kind: 'idle' };
    }

    const idleMs = snap.nowMs - this.idleSinceMs;

    // 抑制条件：电量低、深夜。两者都只影响「搭话」，不影响打招呼。
    if (snap.battery !== null && snap.battery <= this.options.lowBatteryPercent) {
      return { kind: 'idle' };
    }
    if (inQuietHours(snap.localHour, this.options.quietFromHour, this.options.quietToHour)) {
      return { kind: 'idle' };
    }

    // 两次主动开口之间要有最小间隔
    if (snap.nowMs - this.lastProactiveMs < this.options.minProactiveGapMs) {
      return { kind: 'idle' };
    }

    if (idleMs >= this.options.chatterAfterIdleMs) {
      this.markProactive(snap.nowMs);
      return { kind: 'chatter', idleMs };
    }

    return { kind: 'idle' };
  }
}
