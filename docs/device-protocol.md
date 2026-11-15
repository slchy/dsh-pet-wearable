# 线协议

手机 ↔ 本进程之间的最小协议。**写手机端 / SDK 的人看这一份**；改对话逻辑不需要它。

```
[type:u8][len:u32 LE][payload]
```

| 方向 | type | 名字 | payload |
|---|---|---|---|
| 上行 | 1 | `Audio` | mSBC 或 PCM（由设备档位决定） |
| 上行 | 2 | `Image` | JPEG |
| 上行 | 3 | `Wake` | 唤醒事件 |
| 上行 | 4 | `Ping` | — |
| 上行 | 5 | `Status` | UTF-8 JSON，见下 |
| 上行 | 6 | `Hello` | UTF-8 JSON `{proto, deviceId, token, capabilities?, resumed?}` |
| 上行 | 7 | `Event` | v2：UTF-8 JSON `DeviceEvent` |
| 上行 | 8 | `CaptureImage` | v2：`[idLen:u8][id:UTF-8][JPEG]` |
| 下行 | 1 | `Audio` | PCM16 单声道小端 |
| 下行 | 2 | `Control` | UTF-8 ASCII 控制串，见下 |
| 下行 | 3 | `Call` | v2：UTF-8 JSON `DeviceCall` |
| 下行 | 4 | `Welcome` | v2：UTF-8 JSON `{"proto":2}` |
| 下行 | 5 | `Pong` | — |

`Hello` 只在配了鉴权时必需；没配时客户端可以不发。最小实现见
[`tools/fake-phone.ts`](../tools/fake-phone.ts)。v2 的新增帧见下方「v2」一节。

## 下行控制串（`Control=2`）

| 串 | 什么时候发 | 客户端该做什么 |
|---|---|---|
| `stop` | 用户插话，这一轮作废 | 立刻停止播放并清空播放队列 |
| `stop_capture` | 模型调了"退出"工具 | **立刻停止麦克风采集**，但别断开蓝牙会话 —— 告别语还要靠它播完 |
| `take_photo` | 模型调了拍照工具 | 拍一张并回 `Image` 帧（低清档） |
| `take_photo_hq` | 会话里有人要看细节 | 协作式高清：建 P2P → 回 `hq_armed` → **等用户按快门** → 回 `hq_image` + `Image` |
| `hq_cancel` | 不再需要那张高清图 | 立刻解散 P2P，回 `hq_failed`（`reason=cancelled`） |
| `end_session` | 会话该结束了 | 收尾并断开 |
| `auth_required` / `auth_failed` | 鉴权失败 | 检查 token，别重试同一份凭据 |

`stop_capture` 是后补的：在那之前模型一调退出工具，设备会继续采集到整段告别语播完
（实测多采 2–5 秒），既费电又容易把周围对话喂进识别。

## 上行状态帧（`Status=5`，UTF-8 JSON）

高清照必须由**人按下快门**才落盘，所以这条链路上有几十秒是"等用户"。没有状态帧时，
手机早就放弃了，本进程还在干等总超时。

| 事件 | 字段 | 本进程的动作 |
|---|---|---|
| `hq_armed` | `fresh`（`"true"` 表示相机里已有新图） | 结束"等就绪"，开始"等快门"；`fresh=false` 时播一句"请按一下眼镜上的快门" |
| `hq_image` | — | 紧接着的 `Image` 帧算**高清原图**，不是低清回图 |
| `hq_failed` | `reason`：`no_shutter` `p2p` `join` `connect` `arm` `download` `decode` `send` `cancelled` | 立刻结束等待，把原因翻成一句可执行的话给模型 |

`hq_image` 这条公告不能省：等高清图时用户按快门会让相机同时回一张低清图，没有公告就
只能按到达顺序猜 —— 实测把 17 KB 的糊图当成原图交付过。

## 拍照的时间预算

| 段 | 典型 | 兜底（手机侧 / 本进程） |
|---|---|---|
| 建组 + 入组 + 连相册 | 5.4 s | 15 s / — |
| 提示语 | 1.5 s | — |
| 等用户按快门 + 落盘 | 5–9 s | 20 s / 25 s |
| 下载 + 缩图 + 上行 | 2 s | 20 + 10 + 5 s / — |

本进程只有一个兜底总时长：`MIAI_CONFIRM_TIMEOUT_MS`（默认 40000；旧的
`MIAI_HQ_ARM_TIMEOUT_MS` + `MIAI_HQ_SHUTTER_TIMEOUT_MS` 仍认，给了就相加）。
手机侧分段放弃得更早（20 s）并主动上报，所以正常情况下永远是**手机的原因先到**，
这个兜底只管"手机也没消息"。

## 设备原语

控制串是原语在 v1 协议上的投影。判定核只产出 `DeviceCall`，翻译只存在于
[`src/devices/wire-v1.ts`](../src/devices/wire-v1.ts)，因此换协议不用改 `session-core.ts`。

| 原语 | v1 投影 | 语义 |
|---|---|---|
| `audio.stop` | `stop` | 立即停播并清空队列（插话） |
| `listen.stop` | `stop_capture` | 停采集，不断会话 |
| `listen.start{maxMs}` | —（v1 表达不了） | 主动开麦听回应，见下方「开麦」 |
| `capture{id,intent}` | `take_photo` / `take_photo_hq` | 按 `id` 关联、at-most-once、可取消 |
| `capture.cancel{id}` | `hq_cancel` | 幂等 |
| `session.end` | `end_session` | 幂等终态 |
| `capture.waiting{id,say?}` | `hq_armed`（`fresh=false`） | 设备在等用户动手 |
| `capture.failed{id,code,say?}` | `hq_failed{reason}` | 立刻收尾 |
| `presence` / `power` / `summon` / `played` | —（v1 手机没转发） | 宠物环用；`null` = 未知 |

失败码只有 5 个：`unsupported` `busy` `timeout` `cancelled` `failed`。
设备的原因（如没按快门、P2P 没建起来）放在 `say` 里，是给用户听的一句人话，不参与判定。
v1 手机不会说 `say`，由垫片按 `reason` 代说（见 [`src/devices/xiaomi.ts`](../src/devices/xiaomi.ts)）。

## 开麦（`listen.start`）

`listen.start` 只在 v2 里有，而且**只负责把麦克风打开**，不负责出声。小米没有语音会话时
下行 PCM 照样能播（`AudioTrack` 走 A2DP，与会话无关），所以"能不能说"不依赖这条命令。

"麦开了"的信号是**命令发出之后到达的第一帧上行 `Audio`**，服务端自己就能看到，
设备不用另报事件。手机侧的回执（排队成功、SAR ACK）只证明命令进了队列或到了传输层，
不证明设备在采集，不能拿来当这个信号。

小米手机端把 `listen.start` 翻成 `Aivs` id=10（容器字段是 `f11`，不是 `f1`）。
实测从发出到第一帧上行约 0.62 s。`listen.stop` 只停采集、不结束会话（与 v1 的 `stop_capture` 同义），
会话留给下一次开口复用；结束会话是 `session.end`，小米侧对应 `Aivs` id=5（六字段全零，只写 f1 无效）。
这段时间里麦克风没开，用户插话听不到，所以服务端先等首帧再开口；1.5 s 还等不到就照样开口，
宁可听不见插话，也不能沉默。

`maxMs` 是兜底，不是窗口：服务端在回应窗口过期时会主动发 `listen.stop`。
眼镜自己的空闲超时如果比 `maxMs` 更短，会把还没结束的回应窗口截断，所以手机端应把
设备侧的空闲超时设得不短于 `maxMs`。

能力位 `listenStart: false` 的设备（雷鸟能装自己的 APK，麦克风随开随用）不会收到这条命令，
服务端直接开口。

### `Hello.resumed`：别把重连当成「用户想说话」

连接就绪时服务端会主动发一次 `listen.start`，把因为设备侧会话自毁而停掉的采集拉回来
（见上，这修的是「未响应」）。但手机端的 supervisor 在网络抖动、云端重启、心跳超时时
会**自己重连** —— 那种重连不该开麦，否则每次抖一下眼镜都会被唤醒（亮灯、耗电、提示音）。

所以设备在 `Hello` 里带 `resumed: true` 表示「这条是自动重连，不是用户主动开的通道」，
服务端看到就跳过那次 `listen.start`。

| 情况 | `resumed` | 服务端 |
|---|---|---|
| 用户点开通道 / App 启动后第一次连 | 不带（或 `false`） | 发 `listen.start` |
| supervisor 自动重连（第 2 次及以后） | `true` | 不发，日志记「自动重连 → 不主动唤醒设备」 |
| 老 App（不认识这个字段） | 不带 | 发 —— 保持老行为，免得变成「点开了却没声音」 |

用户**手动关掉再打开**是新的连接实例，计数从 0 开始，所以仍然会开麦。

## v2（向下兼容）

v2 只**新增**帧类型，不改任何旧帧的含义。谁说哪个版本由握手定：

```text
设备 ── Hello{proto:2, capabilities} ──▶ 服务端
     ◀── Welcome{"proto":2} ────────── 认了：之后用 Call / Event / CaptureImage
     （没有 Welcome）                   老服务端，或能力不合法：设备照 v1 说话
```

- 老手机（不发 `Hello`，或 `proto:1`）→ 服务端走 v1 垫片，行为不变
- v2 设备连老服务端 → 老服务端不回 `Welcome`，设备退回 v1
- 服务端只在发过 `Welcome` 之后才发 `Call`，所以 v1 手机永远收不到不认识的帧
- `proto` 更高也按 2 说：`Welcome` 里回 2，设备据此降到 2

`capabilities` 的字段见下方原语表与
[`devices/RAYNEO-X3-PRO.md`](devices/RAYNEO-X3-PRO.md) 的示例。

| 帧 | payload |
|---|---|
| `Call` | 一个原语操作，如 `{"op":"listen.start","maxMs":8000}` |
| `Event` | 一条原语事件，如 `{"kind":"presence","wearing":true}` |
| `CaptureImage` | 带请求 id 的图：`[idLen:u8][id][JPEG]` |

用户自己拍的图（不属于任何请求）仍走 v1 的 `Image`。

## 鉴权

`MIAI_TOKENS` 指向一个文件，每行 `token` 或 `token:deviceId`。配了就要求首帧 `Hello`；
没配等于谁都能往这个端口推音频，**所以对公网监听时必须配**（判据见 `bind-policy.ts`：
非本机地址没有 token 直接不监听）。

**token 由部署方生成，不要复用眼镜的 token。** 现场产一个：

```bash
npm run pair -- new --device pixel-9 --host 203.0.113.10 --port 8766 --tls
```

它会追加写入（不覆盖已有设备）并打印一条 `dshpet://pair?...` 配对串，直接贴进手机。

| 值 | 结果 |
|---|---|
| 长度 ≥ 32 字节（hex 形式 ≥ 64 字符） | 接受 |
| 更短 | 启动即失败，指向 `pair new` |
| 32 位 hex（眼镜 token 的形态） | 启动即失败，并说明两者为何不能共用 |

`token:deviceId` 是**真绑定**：`Hello.deviceId` 对不上同样拒绝。
文件改动会被热读 —— 吊销不必重启；已建立的连接不会被踢。

`null` 不等于 `false`：拿不到佩戴状态 ≠ 没戴，拿不到电量 ≠ 没电。协议层不填默认值冒充已知值。
