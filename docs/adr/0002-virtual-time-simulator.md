# ADR-0002 虚拟时间模拟器

- 状态：提议（2026-11-14）
- 关系：细化 ADR-0001 §8；对照已有实现 `src/pet/sim/`（18 个场景全过）

## 1 目标与非目标

目标：AI 不插设备、不联网、不用密钥，就能跑完应用层所有行为，并**自动判对错**；失败时给出能读懂、能复现的时间线。

非目标：音频质量、判停准确率、线协议、真机时序。这些归真机联调。

## 2 现有实现的问题

| # | 问题 | 后果 |
|---|---|---|
| P1 | 只覆盖宠物层。对话（用户说 → agent → TTS → 插话）、拍照收件箱、播报不在模拟里；`turn-runner.ts` 仍直读 `Date.now()` | 应用层一半行为 AI 跑不到 |
| P2 | 心跳和"事件后补 tick"写了两份：生产在 `aliyun-session.ts:590` 和 `:946`，模拟在 `harness.ts` | 两边会漂移，模拟测的是自己的抄本 |
| P3 | 话筒占用由 `scene.say()`/`partial()` 手工模拟 | 生产里 partial 与占话筒的先后顺序没被测到 |
| P4 | `settle()` 最多排空 64 个微任务就返回 | 异步链更长时静默放行，结果依赖实现细节 |
| P5 | `ScriptAgent`、`ScriptVoice` 之外没有延迟与故障注入；agent 回复不占虚拟时间 | `compose` 超时、"等 agent 时用户开口"、晚到的图片都测不到 |
| P6 | 不变量缺 ④ 深夜/低电量、⑤ 佩戴、⑧ 拍照截止；③ 没把播报算进去 | ADR-0001 §8 的承诺没兑现 |
| P7 | 只输出通过/失败 | 失败时 AI 只能看一句错误信息 |
| P8 | 只有手写场景 | 只能发现想到过的问题 |

## 3 设计

### 3.1 测什么：被测对象是整个应用层

被测对象是 `AppSession`（应用层根，包含 `SessionCore`、`PhotoInbox`、播报队列、`FloorArbiter`、`PetSession`），不是 `PetSession` 单独一块。

- 心跳由 `AppSession` 自己用 `clock.every(tickMs)` 驱动；"事件后补 tick"写在 `AppSession.onDeviceEvent` 里。适配层和模拟器**都不调** `tick()`。（解决 P2）
- 话筒由 `AppSession` 收到 `userPartial` 时自己占。模拟器只喂输入，不碰 `acquireFloor`。（解决 P3）
- 模拟器能调的只有 `AppSession` 的公开输入面：`userPartial`、`userFinal`、`deviceEvent`、`image`、`close`。生产适配层用的也是同一组。

### 3.2 时间：单一调度器

```ts
interface Clock {
  now(): number; localHour(): number;
  after(ms: number, fn: () => void): Cancel;
  every(ms: number, fn: () => void): Cancel;
}
```

- 生产 `SystemClock`：`performance.now()`、`new Date().getHours()`、`setTimeout`。
- 模拟 `VirtualClock`：最小堆，键 `(at, seq)`；`seq` 是登记序号，同一时刻按登记顺序触发。**这是唯一的并列规则**。
- `localHour` 由 `startWallMs + now()` 推出，不单独设置。跨过 23 点就自然进入深夜，场景不用手拨。
- 推进算法 `runUntil(t)`：

```text
loop:
  drain()                       # 排空所有微任务，见下
  next = heap.peek()
  if next is None or next.at > t: break
  now = next.at; pop; next.fn()
now = t; drain()
```

- `drain()`：`await new Promise(setImmediate)`，循环到连续两次没有新计时器登记、也没有新输入入队为止。宏任务边界保证当前微任务全部跑完，不设固定上限。（解决 P4）
- **禁令**：`src/app/`、`src/pet/brain/` 里不得出现 `Date.now`、`performance.now`、`new Date`、`setTimeout`、`setInterval`。由一个测试 grep 源码来强制。

### 3.3 假的外部世界

外部世界的每个假件都只通过 `clock.after` 产生延迟，不用真实时间。

| 假件 | 可配置 |
|---|---|
| `SimAgent` | 每次回复的 `latencyMs`、内容、`Error`、永不返回；按 `source.kind` 分别脚本化 |
| `SimVoice` | 每字耗时（默认同 `estimateSpeechMs`）；可选是否发 `played` |
| `SimDevice` | `capture` 回图延迟（可晚于截止）、永不回图、回 `capture.failed{code}`；能力集取 `xiaomi-v1`、`rayneo-v2` 或自定义 |
| `SimUser` | 说话：先 partial、再隔 `speakMs` 出 final；可在任意时刻插话 |

`SimDevice` 的预设能力集**直接引用** `src/devices/xiaomi.ts` 的 `XIAOMI_GLASSES_CAPABILITIES`，不另抄一份。（解决 P5）

### 3.4 场景

```ts
interface Scenario {
  readonly name: string;
  readonly device: 'xiaomi-v1' | 'rayneo-v2' | DeviceCapabilities;
  readonly startAt?: string;               // 墙钟，如 '2026-11-14T12:00'
  readonly world?: Partial<SimWorldConfig>; // 延迟、故障
  readonly script: readonly Step[];         // 声明式，见下
  readonly expect: readonly Expectation[];
}
type Step =
  | { at: string; do: 'wear' | 'unwear' } | { at: string; do: 'say'; text: string; speakMs?: number }
  | { at: string; do: 'tap'; opensSession?: boolean } | { at: string; do: 'battery'; percent: number | null }
  | { at: string; do: 'announce'; text: string } | { at: string; do: 'close' };
type Expectation =
  | { pet: Outcome; reason?: Reason; within?: [string, string] }
  | { spoke: RegExp | 'nothing'; within?: [string, string] }
  | { calls: DeviceCall['op'][] };
```

- `at` 写成 `+25m`、`+3s` 这样的相对时间；声明式步骤便于 AI 生成和改写。
- 需要条件逻辑的场景仍可写成函数，但只能用 `SimUser`/`SimDevice` 的方法，不能碰 `AppSession` 内部。

### 3.5 判定：三层

1. **不变量**：每个场景、每次随机运行都检查。ADR-0001 §8 的十条全部实现，③ 把播报算进去。另加：
   - ⑪ 用户 partial 后 300 ms 内一切在播的声音停止；
   - ⑫ 过期 `step` 的结果被丢弃（晚到的图不进下一次 engagement）；
   - ⑬ 场景结束时没有悬挂的 engagement、没有泄漏的计时器（`close` 之后 `heap` 为空）。
2. **期望**：场景自己的 `expect`。
3. **重放**：把档案里的输入重放一遍，输出逐条相同。

不变量写成对**时间线**的纯函数 `(timeline) → Violation[]`，不嵌在执行过程里。同一套检查也能对生产档案离线跑。（解决 P6）

### 3.6 随机探索

```ts
explore({ seed, runs: 500, horizon: '8h', device: 'any' })
```

- 由种子生成随机步骤序列：戴摘、说话、插话、敲击、电量、播报、拍照故障、agent 延迟与报错、跨越深夜。
- 每次只检查不变量（第 1 层）。
- 发现违反就做**收缩**：逐步删掉步骤、缩短间隔，找到仍能复现的最短序列，写成声明式场景输出。AI 可以直接把它加进 `scenarios/`。（解决 P8）
- CI 用固定种子跑 200 次；本地 `npm run sim -- --explore --runs 5000`。

### 3.7 输出

- 时间线 JSONL：每条 `{t, wall, src, kind, ...}`。`src` 取 `user`、`device`、`agent`、`voice`、`pet.in`、`pet.out`、`floor`、`call`、`violation`。
- 失败时打印：违反了哪条、复现命令（含种子）、违反点前后 2 分钟的时间线摘要。
- `npm run sim -- --trace out/` 把每个场景的时间线写成文件。（解决 P7）

### 3.8 真模型模式（推迟）

`--agent dsh`：`SimAgent` 换成真 dsh。真模型的调用不占虚拟时间：调用期间虚拟时钟暂停，返回后记录真实耗时，但不推进时钟。只用于评估开口说得好不好，不进 CI，不判不变量以外的东西。

## 4 验收

- `npm run sim` 零网络、零密钥、零 ffmpeg，全部场景加 200 次随机探索在 10 秒内跑完。
- 禁令测试通过：应用层源码里没有真实时钟。
- `aliyun-session.ts` 里不再出现 `tick()`、`acquireFloor`。
- 故意改坏任意一条闸门（如去掉 `worn`），随机探索能在固定种子下找出违反并收缩到 5 步以内。

## 5 实现顺序

1. `Clock.every` 与 `VirtualClock` 改成最小堆加 `drain()`；加禁令测试。
2. 心跳和补 tick 收进会话内部，删掉 `harness.ts` 和 `aliyun-session.ts` 里的两份。
3. 时间线与不变量检查改成纯函数，补齐 ④⑤⑧⑪⑫⑬。
4. 加假件的延迟与故障注入，引用真实设备能力集。
5. 声明式场景，把现有 18 个场景迁过去。
6. 随机探索与收缩。
7. `turn-runner.ts` 改走 `Clock`、`Voice`，`AppSession` 把对话层收进来，补对话场景（插话、拍照问答、播报让位）。
