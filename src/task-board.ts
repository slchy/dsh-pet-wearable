/**
 * 破译 dsh 的后台作业状态，给快车道一句**可照实说**的事实。
 *
 * 为什么不让快车道「问 dsh 一句」：那要一整轮（TTFT 实测 p50 690 ms，还要多一条
 * 会话历史）。而这些状态 dsh 本来就**自己发出来了**，只是 `session.ts` 以前只认
 * `assistant/message`，其余全丢掉：
 *
 * | 事件 | 载荷 |
 * |---|---|
 * | `job/registered` | `{jobId, owner, kind, label, startedAt}` —— `bash run_in_background` 开跑 |
 * | `job/settled` | 同一个 `jobId` —— 结算；紧接着 dsh 自己开一轮汇报 |
 * | `subagent/catalog` | `{childId, label, childCreatedAt}` —— 派出了子代理 |
 *
 * 两个容易踩的事实（都是实测）：
 * 1. **子代理的事件带自己的 sessionId**，而且子代理自己跑的 bash 也发 `job/registered`。
 *    所以这里按 `owner` 区分「本机作业」和「子代理的作业」，不能按主会话过滤。
 * 2. 子代理在跑的时候，**主会话状态是 idle** —— 光看 `session.status` 会以为活干完了。
 *
 * 子代理没有可用的结束事件（`subagent/end` 在实测里没出现过），所以清的时机取
 * 「主会话的下一次 `turn/start`」：那条正是它把结果说出来的那一轮。
 */
export interface JobFact {
  readonly jobId: string;
  readonly kind: string;
  readonly label: string;
  readonly startedAt: number;
  /** 发起这个作业的 dsh 会话（主会话 or 子代理） */
  readonly owner: string;
}

export interface SettledFact {
  readonly kind: string;
  readonly label: string;
  readonly settledAt: number;
}

export interface ChildFact {
  readonly childId: string;
  readonly label: string;
  readonly at: number;
}

/** 结算后还能记多久（用户追问「刚才那个好了吗」的窗口） */
const RECENT_MS = 120_000;
/** 只留最近几条结算记录 */
const RECENT_MAX = 4;
/** 一行事实里最多留多少字的作业描述 */
const LABEL_MAX = 28;

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= LABEL_MAX ? one : `${one.slice(0, LABEL_MAX)}…`;
}

function seconds(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))} 秒`;
}

export class TaskBoard {
  private readonly running = new Map<string, JobFact>();
  private readonly recent: SettledFact[] = [];
  private readonly children = new Map<string, ChildFact>();
  /** 主会话 id（`null` = 还没有会话）。用来区分「本机作业」和「子代理的作业」。 */
  private readonly mainSessionId: () => string | null;
  private readonly now: () => number;

  constructor(mainSessionId: () => string | null, now: () => number = Date.now) {
    this.mainSessionId = mainSessionId;
    this.now = now;
  }

  /**
   * 吃一条 `session.event`。不认识的类型直接忽略 —— 只做加法，不改别人的逻辑。
   *
   * @param sessionId 事件所属会话（子代理是它自己的 id）
   * @param type `event.type`
   * @param data `event.data`
   */
  observe(sessionId: string, type: string, data: Record<string, unknown> | undefined): void {
    if (type === 'job/registered') {
      const jobId = typeof data?.['jobId'] === 'string' ? data['jobId'] : '';
      if (jobId === '') return;
      this.running.set(jobId, {
        jobId,
        kind: typeof data?.['kind'] === 'string' ? data['kind'] : 'job',
        label: typeof data?.['label'] === 'string' ? data['label'] : '(无描述)',
        startedAt: typeof data?.['startedAt'] === 'number' ? data['startedAt'] : this.now(),
        owner: sessionId,
      });
      this.children.delete(sessionId);
      return;
    }
    if (type === 'job/settled') {
      const jobId = typeof data?.['jobId'] === 'string' ? data['jobId'] : '';
      const job = this.running.get(jobId);
      if (job === undefined) return;
      this.running.delete(jobId);
      this.recent.unshift({
        kind: job.kind,
        label: job.label,
        settledAt: typeof data?.['settledAt'] === 'number' ? data['settledAt'] : this.now(),
      });
      if (this.recent.length > RECENT_MAX) this.recent.length = RECENT_MAX;
      return;
    }
    if (type === 'subagent/catalog') {
      // catalog 是「当前有哪些子代理」的版本化快照；version 0 带 childId + label
      const childId = typeof data?.['childId'] === 'string' ? data['childId'] : '';
      const label = typeof data?.['label'] === 'string' ? data['label'] : '';
      if (childId === '') return;
      this.children.set(childId, {
        childId,
        label,
        at: typeof data?.['childCreatedAt'] === 'number' ? data['childCreatedAt'] : this.now(),
      });
      return;
    }
    if (type === 'turn/start' && sessionId === this.mainSessionId()) {
      // 主会话又开一轮 = 子代理的结果已经说出来了
      this.children.clear();
    }
  }

  /** 在跑的作业（按开始时间，早的在前） */
  runningJobs(): readonly JobFact[] {
    return [...this.running.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * 渲染成一句给模型看的**事实**。永远返回非空串 —— 「没有在跑的」本身也是事实，
   * 不告诉它，它就会编造进度。
   */
  describe(): string {
    const now = this.now();
    const jobs = this.runningJobs();
    const main = this.mainSessionId();
    const parts: string[] = [];

    for (const job of jobs) {
      const who = job.owner === main ? '' : '子代理的 ';
      parts.push(`${who}${job.kind}「${clip(job.label)}」已跑 ${seconds(now - job.startedAt)}`);
    }
    for (const child of this.children.values()) {
      parts.push(`子代理「${clip(child.label)}」已派出、还没回结果`);
    }

    if (parts.length > 0) {
      return `后台任务：在跑 ${parts.length} 个 —— ${parts.join('；')}。`;
    }

    const last = this.recent[0];
    if (last !== undefined && now - last.settledAt <= RECENT_MS) {
      return `后台任务：现在没有在跑的；刚结束 ${last.kind}「${clip(last.label)}」`
        + `（${seconds(now - last.settledAt)}前）。`;
    }
    return '后台任务：现在没有任何后台任务在跑，也没刚结束的。';
  }
}
