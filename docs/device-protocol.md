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
| 上行 | 6 | `Hello` | UTF-8 JSON `{proto, deviceId, token, capabilities?}` |
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
| `listen.start{maxMs}` | —（v1 表达不了） | 主动开麦听回应 |
| `capture{id,intent}` | `take_photo` / `take_photo_hq` | 按 `id` 关联、at-most-once、可取消 |
| `capture.cancel{id}` | `hq_cancel` | 幂等 |
| `session.end` | `end_session` | 幂等终态 |
| `capture.waiting{id,say?}` | `hq_armed`（`fresh=false`） | 设备在等用户动手 |
| `capture.failed{id,code,say?}` | `hq_failed{reason}` | 立刻收尾 |
| `presence` / `power` / `summon` / `played` | —（v1 手机没转发） | 宠物环用；`null` = 未知 |

失败码只有 5 个：`unsupported` `busy` `timeout` `cancelled` `failed`。
设备的原因（如没按快门、P2P 没建起来）放在 `say` 里，是给用户听的一句人话，不参与判定。
v1 手机不会说 `say`，由垫片按 `reason` 代说（见 [`src/devices/xiaomi.ts`](../src/devices/xiaomi.ts)）。

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
没配等于谁都能往这个端口推音频，**所以对公网监听时必须配**。

`null` 不等于 `false`：拿不到佩戴状态 ≠ 没戴，拿不到电量 ≠ 没电。协议层不填默认值冒充已知值。
