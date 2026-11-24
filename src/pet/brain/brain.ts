/**
 * `PetBrain`：**纯 reducer**。`step(state, input) → { state, intents }`。
 *
 * 对应 ADR-0001 §4–§5。
 *
 * <h2>它不做什么</h2>
 *
 * - 不读时钟：`now` / `localHour` 在输入里
 * - 不做 I/O：副作用只能通过 {@link PetIntent} 表达
 * - 不用随机数：要随机时把种子作为输入传进来
 *
 * <h2>唯一入口</h2>
 *
 * `idle → engaging` **只**发生在 `tick` 上。其它输入只更新事实、打断、或推进阶段。
 * 「什么时候开口」因此只有一个入口，重放时一眼可查。
 */
import type { DeviceCapabilities } from '../../devices/primitives.ts';
import {
  DEFAULT_PET_PARAMS,
  GATES,
  PHASES,
  TRIGGERS,
  estimateSpeechMs,
  type Candidate,
  type PetParams,
  type Trigger,
} from './registry.ts';
import type {
  Engagement,
  Interrupt,
  Outcome,
  PetContext,
  PetInput,
  PetInputStamp,
  PetIntent,
  PetOutcomeRecord,
  PetState,
  PetStepResult,
  PetWorld,
  PhaseId,
  Verdict,
} from './types.ts';

export class PetBrain {
  readonly params: PetParams;

  constructor(params: Partial<PetParams> = {}) {
    this.params = { ...DEFAULT_PET_PARAMS, ...params };
  }

  /** 新会话的初始状态。 */
  initial(caps: DeviceCapabilities, stamp: PetInputStamp): PetState {
    return {
      world: {
        now: stamp.now,
        localHour: stamp.localHour,
        // 设备不报佩戴 ⇒ 恒为 null，`worn` 闸门因此永远不通过（ADR §5.3）
        wearing: null,
        donnedAt: null,
        lastAwayMs: null,
        battery: null,
        lastUserAt: null,
        lastVoiceAt: null,
        floorBusy: false,
        floorOwner: null,
        announcePending: false,
        caps,
        awaySince: null,
      },
      engagement: null,
      fired: new Set<string>(),
      seq: 0,
    };
  }

  /**
   * 归约一条输入。
   *
   * @returns 新状态与要执行的意图。**不修改**传入的 `state`。
   */
  step(state: PetState, input: PetInput): PetStepResult {
    const world = reduceWorld(state.world, input);

    // ---------------------------------------------------------------- 连接关闭
    if (input.kind === 'closed') {
      if (state.engagement === null) {
        return { state: { ...state, world }, intents: [] };
      }
      const done = finish(
        state.engagement,
        // 连接都没了，麦也跟着没了；closeMic 只是让执行器收掉本地状态
        { kind: 'end', outcome: 'aborted', closeMic: true },
        world,
        state.fired,
      );
      return {
        state: { ...state, world: done.world, engagement: null, fired: done.fired },
        intents: done.intents,
      };
    }

    // ---------------------------------------------------------------- 有 engagement
    const engagement = state.engagement;
    if (engagement !== null) {
      const interrupt = deriveInterrupt(input, world);
      if (interrupt !== null) {
        const verdict = verdictOf(engagement, 'onInterrupt', interrupt);
        return settle(engagement, verdict, world, state.fired, this.params, { ...state, world });
      }

      const phase = currentPhase(engagement);

      if (input.kind === 'micOpened') {
        // 首帧上行到了：麦真的开了。只在 listen 阶段有意义
        if (phase !== 'listen') {
          return { state: { ...state, world }, intents: [] };
        }
        const opened: Engagement = { ...engagement, micOpened: true };
        const verdict = verdictOf(opened, 'onResult', 'opened');
        return settle(opened, verdict, world, state.fired, this.params, {
          ...state,
          world,
          engagement: opened,
        });
      }

      if (input.kind === 'phaseResult') {
        // `step` 只在一次 engagement 内单调；`engagementId` 才挡得住上一次的晚到结果
        if (input.engagementId !== engagement.id
          || input.step !== engagement.step
          || input.phase !== phase) {
          return { state: { ...state, world }, intents: [] };
        }
        const withPayload = absorbPayload(engagement, input);
        // listen 超时 = 麦没开。照样开口，但结局里记 `micOpened: false`
        const marked: Engagement = input.phase === 'listen' && input.result === 'timeout'
          ? { ...withPayload, micOpened: false }
          : withPayload;
        const verdict = verdictOf(marked, 'onResult', input.result);
        return settle(marked, verdict, world, state.fired, this.params, {
          ...state,
          world,
          engagement: marked,
        });
      }

      if (input.kind === 'image' && phase === 'look' && input.id === engagement.bag.captureId) {
        const got: Engagement = { ...engagement, bag: { ...engagement.bag, image: input.image } };
        const verdict = verdictOf(got, 'onResult', input.image === null ? 'none' : 'got');
        return settle(got, verdict, world, state.fired, this.params, {
          ...state,
          world,
          engagement: got,
        });
      }

      // 其余输入（tick / floor / announce …）只更新事实
      return { state: { ...state, world }, intents: [] };
    }

    // ---------------------------------------------------------------- 空闲：敲击
    if (input.kind === 'summon') {
      if (input.opensSession) {
        // 这个手势同时开语音会话：归对话层，宠物不抢、也不播反射音
        return { state: { ...state, world }, intents: [] };
      }
      if (world.floorOwner === 'announce' || world.announcePending) {
        // 播报在播：敲一下先把它关掉，不叠一句「在呢」
        return { state: { ...state, world }, intents: [{ kind: 'announce.dismiss' }] };
      }
      return { state: { ...state, world }, intents: [{ kind: 'reflex', cue: 'here' }] };
    }

    // ---------------------------------------------------------------- 空闲：唯一入口
    if (input.kind !== 'tick') {
      return { state: { ...state, world }, intents: [] };
    }

    const picked = pickTrigger(world, state.fired, this.params);
    if (picked === null) {
      return { state: { ...state, world }, intents: [] };
    }

    const plan = picked.trigger.plan(world);
    const context: PetContext = {
      reason: picked.trigger.reason,
      elapsedMs: picked.candidate.elapsedMs,
      hasImage: plan.includes('look'),
      ...(picked.candidate.notes === undefined ? {} : { notes: picked.candidate.notes }),
    };
    const seq = state.seq + 1;
    const id = `pet-${seq}`;
    const started: Engagement = {
      id,
      reason: picked.trigger.reason,
      key: picked.candidate.key,
      plan,
      at: 0,
      step: 1,
      startedAt: world.now,
      // 拍照 id 与 engagement 编号相同：一次开口至多拍一张，不需要独立计数
      bag: { image: null, captureId: id, text: null, emotion: null },
      context,
      spokeAt: plan[0] === 'speak' ? world.now : null,
      micOpened: null,
      durations: {},
      phaseEnteredAt: world.now,
    };
    // `lastAwayMs` 先留着。`abandoned` 会把候选键从 `fired` 里删掉，
    // 若在开场就清掉离场时长，同一次佩戴就再也打不了招呼。消费放在 `finish()`。
    const fired = new Set(state.fired).add(picked.candidate.key);
    return {
      state: { ...state, world, engagement: started, fired, seq },
      intents: [enterIntent(started, world, this.params)],
    };
  }
}

// ---------------------------------------------------------------- 世界归约

/** 世界归约：**只更新事实**，不做任何判断。 */
function reduceWorld(w: PetWorld, input: PetInput): PetWorld {
  const base: PetWorld = { ...w, now: input.now, localHour: input.localHour };
  switch (input.kind) {
    case 'presence': {
      // 设备不报佩戴时，永远是"读不到"
      const wearing = w.caps.presence ? input.wearing : null;
      if (wearing === w.wearing) {
        return base;
      }
      if (wearing === false) {
        return { ...base, wearing, awaySince: w.awaySince ?? input.now };
      }
      if (wearing === true) {
        const awayMs = w.awaySince === null ? null : input.now - w.awaySince;
        return { ...base, wearing, awaySince: null, lastAwayMs: awayMs, donnedAt: input.now };
      }
      // 读不到：清掉离场计时，**不**补打招呼；若上一段是"已知没戴"，闲置从此重算
      return {
        ...base,
        wearing,
        awaySince: null,
        lastAwayMs: null,
        donnedAt: w.wearing === false ? input.now : w.donnedAt,
      };
    }
    case 'power':
      return { ...base, battery: input.percent };
    case 'userPartial':
    case 'userFinal':
      return { ...base, lastUserAt: input.now };
    case 'summon':
      // 普通敲击等同"用户找我"：刷新闲置锚点。会开语音会话的那种归对话层，不算。
      return input.opensSession ? base : { ...base, lastUserAt: input.now };
    case 'floor':
      return { ...base, floorBusy: input.busy, floorOwner: input.owner };
    case 'closed':
      // 连接没了，话筒一定是空的。`PetSession.close` 会先清仲裁器，这里把投影对齐。
      return { ...base, floorBusy: false, floorOwner: null };
    case 'announce':
      // 播报出声也算"最近出过声"：不占最小间隔，但会推迟下一次搭话（ADR-0001 §6）
      return input.spoken
        ? { ...base, announcePending: input.pending, lastVoiceAt: input.now }
        : { ...base, announcePending: input.pending };
    default:
      return base;
  }
}

// ---------------------------------------------------------------- 打断

function deriveInterrupt(input: PetInput, world: PetWorld): Interrupt | null {
  switch (input.kind) {
    case 'userPartial':
    case 'userFinal':
      return 'userActivity';
    case 'summon':
      // 会开语音会话的敲击归对话层
      return input.opensSession ? null : 'tap';
    case 'presence':
      return world.wearing === true ? null : 'presenceLost';
    case 'floor':
      // 自己占着话筒不算被抢
      return input.busy && input.owner !== 'pet' ? 'floorTaken' : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------- 候选

interface Picked {
  readonly trigger: Trigger;
  readonly candidate: Candidate;
}

function pickTrigger(world: PetWorld, fired: ReadonlySet<string>, params: PetParams): Picked | null {
  let best: Picked | null = null;
  for (const trigger of TRIGGERS) {
    const candidate = trigger.candidate(world, fired, params);
    if (candidate === null) {
      continue;
    }
    // 闸门是命名的纯谓词；任何一个不过就不算候选
    if (trigger.gates.some((gate) => !GATES[gate](world, params))) {
      continue;
    }
    if (best === null || trigger.priority > best.trigger.priority) {
      best = { trigger, candidate };
    }
  }
  return best;
}

// ---------------------------------------------------------------- 阶段

function currentPhase(e: Engagement): PhaseId {
  const phase = e.plan[e.at];
  if (phase === undefined) {
    throw new Error(`pet: engagement ${e.id} 的阶段下标 ${e.at} 越界（plan=${e.plan.join(' → ')}）`);
  }
  return phase;
}

function verdictOf(e: Engagement, table: 'onResult' | 'onInterrupt', key: string): Verdict {
  const spec = PHASES[currentPhase(e)];
  const map: Record<string, Verdict | undefined> = table === 'onResult' ? spec.onResult : spec.onInterrupt;
  const verdict = map[key];
  if (verdict === undefined) {
    throw new Error(`pet: 阶段 ${spec.id} 没有为 ${table}[${key}] 定义决断`);
  }
  return verdict;
}

/** 把阶段结果里的负载并进 bag（`compose.reply` / `look.got`）。 */
function absorbPayload(e: Engagement, input: Extract<PetInput, { kind: 'phaseResult' }>): Engagement {
  const payload = input.payload;
  if (payload === undefined) {
    return e;
  }
  return {
    ...e,
    bag: {
      ...e.bag,
      text: payload.text ?? e.bag.text,
      emotion: payload.emotion ?? e.bag.emotion,
      image: payload.image === undefined ? e.bag.image : payload.image,
    },
  };
}

/** 离开当前阶段：累计耗时。 */
function stampDurations(e: Engagement, now: number): Readonly<Partial<Record<PhaseId, number>>> {
  const phase = currentPhase(e);
  const spent = Math.max(0, now - e.phaseEnteredAt);
  return { ...e.durations, [phase]: (e.durations[phase] ?? 0) + spent };
}

/** `phase.enter` 意图：把阶段规格翻译成执行器能直接做的一件事。 */
function enterIntent(e: Engagement, world: PetWorld, params: PetParams): PetIntent {
  const phase = currentPhase(e);
  const text = e.bag.text ?? '';
  // 开麦只在 listen 阶段：先开着听，才接得住用户的第一句回应
  const listenMs = phase === 'listen'
    ? params.micOpenTimeoutMs + estimateSpeechMs(text) + params.listenMs
    : null;
  return {
    kind: 'phase.enter',
    engagementId: e.id,
    phase,
    step: e.step,
    plan: e.plan,
    context: e.context,
    deadlineMs: PHASES[phase].deadlineMs(params),
    captureId: phase === 'look' ? e.bag.captureId : null,
    text: phase === 'speak' ? text : null,
    emotion: phase === 'speak' ? e.bag.emotion : null,
    image: phase === 'compose' ? e.bag.image : null,
    listenMs,
    holdsFloor: PHASES[phase].holdsFloor,
  };
}

// ---------------------------------------------------------------- 决断落地

/**
 * 落地一个决断。
 *
 * @param current 已经带上本步负载的状态（`engagement` 可能已被替换）
 */
function settle(
  e: Engagement,
  verdict: Verdict,
  world: PetWorld,
  fired: ReadonlySet<string>,
  params: PetParams,
  current: PetState,
): PetStepResult {
  if (verdict.kind === 'end') {
    const done = finish(e, verdict, world, fired);
    return {
      state: { ...current, world: done.world, engagement: null, fired: done.fired },
      intents: done.intents,
    };
  }

  const at = e.at + 1;
  const nextPhase = e.plan[at];
  if (nextPhase === undefined) {
    throw new Error(`pet: engagement ${e.id} 的 ${currentPhase(e)} 要求 next，但计划已到末尾`);
  }
  const advanced: Engagement = {
    ...e,
    at,
    step: e.step + 1,
    durations: stampDurations(e, world.now),
    phaseEnteredAt: world.now,
    spokeAt: nextPhase === 'speak' ? world.now : e.spokeAt,
  };
  return {
    state: { ...current, engagement: advanced },
    intents: [enterIntent(advanced, world, params)],
  };
}

/** 是否算"出过声"。见 ADR §5.6。 */
function speechCounted(outcome: Outcome, e: Engagement): boolean {
  switch (outcome) {
    case 'engaged':
    case 'ignored':
    case 'dismissed':
      return true;
    case 'declined':
    case 'failed':
    case 'abandoned':
      return false;
    case 'aborted':
      return e.spokeAt !== null;
  }
}

function finish(
  e: Engagement,
  verdict: Extract<Verdict, { kind: 'end' }>,
  world: PetWorld,
  fired: ReadonlySet<string>,
): { fired: ReadonlySet<string>; intents: readonly PetIntent[]; world: PetWorld } {
  const base: PetOutcomeRecord = {
    id: e.id,
    reason: e.reason,
    outcome: verdict.outcome,
    phase: currentPhase(e),
    durations: stampDurations(e, world.now),
    startedAt: e.startedAt,
    endedAt: world.now,
  };
  // `micOpened` 只在计划含 listen 时出现（ADR-0001 §5.6）
  const record: PetOutcomeRecord = e.plan.includes('listen')
    ? { ...base, micOpened: e.micOpened === true }
    : base;
  // abandoned = 出声前就散了：候选键不写入 fired，以后还能再触发
  const nextFired = verdict.outcome === 'abandoned'
    ? new Set([...fired].filter((key) => key !== e.key))
    : fired;
  // 只有真出过声才推进 lastVoiceAt；`declined` / `failed` / `abandoned` 不该推迟下一次
  const voiced = speechCounted(verdict.outcome, e);
  // greet 的离场事实只在非 abandoned 时消费。abandoned 删了 fired 键之后，
  // 还得留着 lastAwayMs，同一次佩戴的下一次心跳才能再打招呼。
  const consumeAway = e.reason === 'greet' && verdict.outcome !== 'abandoned';
  const nextWorld: PetWorld = voiced || consumeAway
    ? {
      ...world,
      ...(voiced ? { lastVoiceAt: world.now } : {}),
      ...(consumeAway ? { lastAwayMs: null } : {}),
    }
    : world;
  return {
    fired: nextFired,
    intents: [{
      kind: 'end',
      record,
      dismiss: verdict.dismiss === true,
      closeMic: verdict.closeMic === true,
    }],
    world: nextWorld,
  };
}
