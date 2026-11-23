/**
 * 判停前预跑 / 中间结果投机的**那一个槽位**。
 *
 * 从 `fronted-agent.ts` 拆出来的原因：这套东西有自己的一整套状态（起跑没起跑、
 * 文本是不是猜的、攒下的字有没有人接、失败时是死结果还是有半截），和「路由 /
 * 历史 / 账本」完全无关。混在一个类里时，最要命的那条不变量（`listener` 必须装在
 * **同一个对象**上）根本看不出来。
 *
 * <h2>一条不变量</h2>
 *
 * `ask()` 的回调闭包捕获的是创建时的那个 slot。认领时如果换成一份拷贝
 * （`{ ...slot }`），`listener` 就只装在拷贝上，闭包里的原对象永远是 `null` ——
 * 认领之后的增量继续往 `buffered` 里堆，没人再取，TTS 拿到空文本，每一轮都退回
 * 整段合成（实测白付 300–500 ms）。所以槽位对外只给**认领对象本身**。
 */
import { EVENTS } from './events.ts';
import type { FastAnswer } from './fast-llm-client.ts';

/**
 * 中间结果最少几个字才值得投机。**默认 6**。
 *
 * 2026-11-18 试过降到 2（`42ac09e`），想在「2–5 字短句」上把 agent 藏进 ① 里。
 * **真机向量 14 场回放测下来不成立**：`agent.ask(kind=spec)` 从 11 次涨到 27 次，
 * 端到端 p50 1047 → 1048（没动），同句配对的差还在噪声里 —— 花 2.5 倍请求买不到中位。
 * 账见 `docs/OPS-RECORD.md` §12.8。所以退回 6；要再试就改 `FAST_LANE_SPEC_MIN_CHARS`，
 * 不用改代码。
 */
export const SPEC_MIN_CHARS = 6;

/**
 * 中间结果尾部常挂着「，」「？」这种标点（ASR 边解码边补），比对前去掉。
 *
 * **`？` 和 `！` 必须一起去掉**（2026-11-19 抓到）：真机档案里那句
 * `'台词的经典是台词是什么？'`，定稿是 `'台词的经典是台词是什么来着？'` ——
 * ASR 在定稿时把「来着」补进去了，于是带问号的投机**不是前缀**、被白白作废；
 * 去掉尾标点后它覆盖 79%、完全该认。真机 6 场里这一句 6/6 都栽在这上面。
 *
 * 去标点不会引入误认：认领仍要求「去标点后的投机与定稿**完全一致**」，而认领时
 * 喂给模型的是**定稿文本**（见 `FrontedAgent.prefetch`）。
 */
export function stripPartialTail(text: string): string {
  return text.replace(/[\s，,。.、；;：:？?！!…～~]+$/u, '');
}

/**
 * **比对专用**的归一化：去掉全部标点和空白。
 *
 * 只用 `stripPartialTail` 不够（2026-11-19 核对出来）：ASR 的流式 partial 通常
 * **不带句中逗号**，而定稿带 —— `对呀那你知道蓝母吗` 对 `对呀，那你知道蓝母吗？`
 * 文字完全相同，却因为一个逗号认不了。脚本 `scripts/partial-timeline.py` 一直是
 * 按「去全部标点」算的，两边必须用同一把尺，否则线上的命中会比统计少。
 *
 * 去全部标点不引入误认：认领时喂给模型的是**定稿文本**（见 `prefetch`），
 * 标点差异只影响「认不认」，不影响「问了什么」。
 */
export function normalizeForCompare(text: string): string {
  return text.replace(/[\s，,。.、；;：:？?！!…～~“”"'‘’（）()《》〈〉【】\[\]{}—－·/\\|]+/gu, '');
}

/**
 * 定稿是否确认这份投机文本 —— **这条路唯一的闸门**，错了就会答非所问。
 *
 * **只认「去标点后完全一致」**（2026-11-19 收紧，原来是「前缀 + 覆盖 ≥60%」）。
 *
 * 为什么收：逐轮 dump 出来，被 60% 门槛放过的那一半，缺的正是**宾语** ——
 * `080409` 轮 4 认下「对呀，那你知道」（定稿「对呀，那你知道蓝母吗？」）、
 * 轮 5 认下「你给我详细介绍一下」（定稿「…佛拉尼斯。」）。模型只能反问，
 * 用户听到的是「答非所问」，而档案里 `tts.first` 一切正常 —— 只有 `agent.spec`
 * 的 `missing` 字段能查出来。
 *
 * 收益几乎不损失（`scripts/partial-timeline.py` 三场 52 轮）：
 *
 * | 门槛 | 达标 | 提前量中位 | p90 |
 * |---|---|---|---|
 * | 前缀 + 覆盖 ≥60% | 34/52 | 32 ms | 587–879 |
 * | 去标点后完全一致 | 52/52 | **16 ms** | 19–313 |
 *
 * 还有 8 轮（52 轮里）partial 在定稿前 **300–423 ms** 就已经完全一致，
 * 是 `asr.sentence` 在等静音确认 —— 那一档收益照拿，且零风险。
 */
export function acceptsSpeculation(spec: string, final: string, minChars = SPEC_MIN_CHARS): boolean {
  const s = normalizeForCompare(spec);
  const f = normalizeForCompare(final);
  if (s.length < minChars) return false;
  return s === f;
}

/** 一个槽位。字段含义见各条注释；生命周期只有 start → (confirm) → take/drop。 */
interface Slot {
  /** 认领时拿来比对的文本：投机起跑时是**中间结果**，被定稿确认后改写成定稿 */
  text: string;
  /** 这一趟是用中间结果起的（还没被定稿确认） */
  speculative: boolean;
  readonly startedAt: number;
  answer: Promise<FastAnswer>;
  readonly buffered: string[];
  /**
   * 这一趟的结局。`fail` 在认领时是**能读到的**：
   *
   * 预跑可能在轮次真正开跑之前就已经失败（先例：2026-11-22 17:30 那轮，
   * 「Hmm.」的预跑 1200 ms 首字超时死在 12.6 s，轮次 13.9 s 才开）。
   * 以前这时 `take` 照样报 `ok: true` —— 仪表上说「命中」，实际认到的是
   * 一份死结果。**行为保持不变**（那条路径顺带救回了半截答案），只把真相记下来。
   */
  state: 'pending' | 'ok' | 'fail';
  abort: { abort(why: Error): void } | null;
  listener: ((text: string) => void) | null;
}

/** 起跑一趟请求。返回的 promise 在**第一个 await 之前**必须已经装好取消句柄。 */
export type PrefetchAsk = (
  text: string,
  startedAt: number,
  emit: (text: string) => void,
  kind: 'spec' | 'prefetch',
) => Promise<FastAnswer>;

export interface PrefetchSlotOptions {
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly audit: (name: string, data: Record<string, unknown>) => void;
  readonly ask: PrefetchAsk;
  /** 刚才那一趟的取消句柄（`ask()` 同步装好，这里紧接着取） */
  readonly abortOf: () => { abort(why: Error): void } | null;
}

/**
 * 预跑槽位：**同一时刻只有一个**。新的一句到来时把旧的顶掉（判停并段就是这么发生的）。
 */
export class PrefetchSlot {
  private current: Slot | null = null;
  private readonly options: PrefetchSlotOptions;

  constructor(options: PrefetchSlotOptions) {
    this.options = options;
  }

  /** 有没有一趟在跑 / 已经被认领（决定 `prefetch()` 该不该报「已经在跑了」） */
  get has(): boolean {
    return this.current !== null;
  }

  /** 当前这一趟用来比对的文本；没有就是 `null` */
  get text(): string | null {
    return this.current?.text ?? null;
  }

  /** 当前这一趟是不是还没有定稿确认的猜测 */
  get speculative(): boolean {
    return this.current?.speculative === true;
  }

  /**
   * 起跑一趟。并段走的是**这一条**：新一句（更长的累积文本）到来时把旧的顶掉。
   * 所以日志要写清是哪种情况，别让「判停并了段」那句永远打不出来。
   */
  start(text: string, speculative: boolean): void {
    const prev = this.current;
    this.drop(
      prev !== null && text.startsWith(prev.text)
        ? `判停并了段，改用 ${JSON.stringify(text)} 重新起跑`
        : '换一句',
    );
    const slot: Slot = {
      text,
      speculative,
      startedAt: this.options.now(),
      answer: null as unknown as Promise<FastAnswer>,
      buffered: [],
      state: 'pending',
      abort: null,
      listener: null,
    };
    slot.answer = this.options.ask(text, slot.startedAt, (chunk) => {
      if (slot.listener !== null) {
        slot.listener(chunk);
        return;
      }
      slot.buffered.push(chunk);
    }, speculative ? 'spec' : 'prefetch');
    // 预跑出来的 promise 可能永远没人认领（插话/并段）：接住，别让它变成进程级 rejection
    slot.answer.catch(() => undefined);
    // 同一份 promise 上再挂一个：只为记下结局，供认领时判断这是不是一份死结果
    slot.answer.then(
      () => { slot.state = 'ok'; },
      () => { slot.state = 'fail'; },
    );
    // `ask()` 在第一个 await 之前同步设好了控制器，这里取到的就是这一趟的
    // **同一个对象**，不能 `{ ...slot }`（见文件头的不变量）
    slot.abort = this.options.abortOf();
    this.current = slot;
    this.options.log(
      `${speculative ? '  快车道    中间结果先问出去' : '  快车道    判停前先问出去'} ${JSON.stringify(text)}`,
    );
  }

  /**
   * 定稿确认了这份投机：把文本改写成定稿，后面 `take()` 按一字不差认领。
   *
   * 返回 `false` = 对不上 / 不是投机起的那一趟 —— 调用方该走「按定稿重新问」。
   */
  confirmSpeculation(finalText: string, minChars: number): boolean {
    const slot = this.current;
    if (slot === null || !slot.speculative) return false;
    if (!acceptsSpeculation(slot.text, finalText, minChars)) return false;
    const { now, audit, log } = this.options;
    // 投机缺掉的那截尾巴必须落档：认领门槛只要求「完全一致」，对不上的常常是
    // 宾语（「那你知道」← 「那你知道蓝母吗？」）。不记下来，「模型为什么反问」
    // 就永远查不到（见 `EVENTS.agentSpec`）。
    const specCore = stripPartialTail(slot.text);
    audit(EVENTS.agentSpec, {
      ok: true,
      spec: slot.text,
      final: finalText,
      spec_chars: specCore.length,
      final_chars: finalText.length,
      coverage: Number(
        (normalizeForCompare(slot.text).length
          / Math.max(1, normalizeForCompare(finalText).length)).toFixed(3),
      ),
      missing: finalText.slice(specCore.length),
      ran_for_ms: Math.round(now() - slot.startedAt),
    });
    log(
      `  快车道    投机被定稿确认（${JSON.stringify(slot.text)} → ${JSON.stringify(finalText)}，`
      + `已跑 ${(now() - slot.startedAt).toFixed(0)} ms）`,
    );
    slot.text = finalText;
    // 定稿之后这一趟就是「预跑」了：再来更长的文本（判停并段）走原来的重问路径，
    // 不能再用这段确认逻辑把它当成「还是同一句」
    slot.speculative = false;
    return true;
  }

  /**
   * 认领预跑：文本一字不差、且这一轮确实会走快车道才给，其余一律作废。
   *
   * 第二条（`usable`）不是优化，是**止损**：宿主的判据与这里不同源时，
   * 预跑会在「根本不会走快车道」的轮次上白花一次调用。
   */
  take(
    userText: string,
    usable: boolean,
  ): { answer: Promise<FastAnswer>; attach: (sink: (text: string) => void) => void } | null {
    const slot = this.current;
    if (slot === null) return null;
    this.current = null;
    const { now, log, audit } = this.options;
    if (!usable) {
      this.abortSlot(slot);
      log(`  快车道    这一轮不走快车道，预跑作废（${JSON.stringify(slot.text)}）`);
      audit(EVENTS.agentClaim, { ok: false, why: 'unusable', text: slot.text });
      return null;
    }
    if (slot.text !== userText) {
      this.abortSlot(slot);
      log(
        `  快车道    文本对不上，预跑作废（${JSON.stringify(slot.text)} → ${JSON.stringify(userText)}）`,
      );
      audit(EVENTS.agentClaim, {
        ok: false, why: 'text-mismatch', text: slot.text, want: userText,
      });
      return null;
    }
    const ranFor = now() - slot.startedAt;
    const produced = slot.buffered.length;
    if (slot.state === 'fail') {
      if (produced === 0) {
        // 开轮时这份预跑早就死了，而且**一个字都没产出** —— 没东西可救。
        //
        // **别把它当命中交出去**：`await` 一个已经 reject 的 promise 会立刻抛，
        // 于是这一轮**跳过「现场重跑」**直接掉 dsh。2026-11-22 17:30 那轮就是这么来的：
        // 预跑 1201 ms 首字超时死在 12.6 s，轮次 13.9 s 才开，认领后一路交给 dsh，
        // 1.2 s 的偶发波动被放大成 18.5 s。
        log(
          `  快车道    预跑已失败且无产出（跑了 ${ranFor.toFixed(0)} ms）→ 现场重新问一次`,
        );
        audit(EVENTS.agentClaim, {
          ok: false, why: 'failed', taken: false, produced, text: slot.text,
          ran_for_ms: Math.round(ranFor),
        });
        return null;
      }
      // 已经产出过字：**保持原行为**。`attach` 会把那几段先补推出去，随后的 reject
      // 让 `reply()` 走「已播出一部分，按现有文本收下」—— 这半截答案是白捡的，
      // 重问一次反而把它丢掉。
      log(
        `  快车道    认领到一份**已经失败**的预跑（跑了 ${ranFor.toFixed(0)} ms，`
        + `已产出 ${produced} 段）→ 按现有文本收下`,
      );
      audit(EVENTS.agentClaim, {
        ok: false, why: 'failed-partial', taken: true, produced, text: slot.text,
        ran_for_ms: Math.round(ranFor),
      });
    } else {
      log(`  快车道    认领预跑（已经跑了 ${ranFor.toFixed(0)} ms）`);
      audit(EVENTS.agentClaim, { ok: true, text: slot.text, ran_for_ms: Math.round(ranFor) });
    }
    return {
      answer: slot.answer,
      attach: (sink) => {
        // 先把预跑期间攒下的字补推出去，再切成实时 —— 顺序反了会乱序
        for (const chunk of slot.buffered) sink(chunk);
        slot.buffered.length = 0;
        slot.listener = sink;
      },
    };
  }

  /** 这一趟不要了（换一句 / 判停并段 / 文本对不上）。没有槽位时什么都不做。 */
  drop(why: string): void {
    const slot = this.current;
    if (slot === null) return;
    this.current = null;
    this.abortSlot(slot);
    this.options.log(`  快车道    预跑作废（${why}）`);
    this.options.audit(EVENTS.agentDrop, { why, text: slot.text, speculative: slot.speculative });
  }

  /**
   * **无条件掐**：`handle` 是那一趟 `ask()` 自己的 `abort`，它只会 abort 那一组
   * controller，碰不到别的轮次。
   *
   * 原来（这套逻辑还在 `FrontedAgent` 里时）这里有一道 `askAbort === handle` 的守卫，
   * 注释说「已经被别的 ask() 顶替过就别动它，会掐掉正在服务的那一轮」—— **反了**：
   * 被顶替之后 `handle` 恰恰是那份没人要的旧请求，正是该掐的对象；而正在服务的那一轮
   * 有自己的 handle，动不了。那道守卫的实际后果是：**任何被顶掉的预跑都再也取消不掉**，
   * 只能自己跑满（最长 `totalMs` 2.8 s），白占一条连接、白花 token。
   */
  private abortSlot(slot: Slot): void {
    if (slot.abort !== null) {
      slot.abort.abort(new Error('预跑作废'));
    }
  }
}
