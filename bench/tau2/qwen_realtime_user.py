"""τ²-bench 的「模拟顾客」：用 Qwen-Audio realtime 直接说人话、听人话。

<h2>为什么不用它自带的 `VoiceUserSimulator`</h2>

tau2 的顾客是「文本 LLM 扮演人设 + ElevenLabs 合成」两段拼出来的：它**听不见**对面，
只能靠 agent 的文字转写来计时。我们手上没有 ElevenLabs，而且它压不出真正的打断 ——
顾客的插话是调度器排出来的，不是听出来的。

Qwen-Audio realtime（DashScope）是端到端全双工：一边收音频、一边出声、自带服务端
VAD 和插话。拿它当顾客，"顾客真的插话"才会自然发生。

<h2>抄的是谁</h2>

- 协议：`tau2/voice/audio_native/qwen/provider.py`（同一套 `session.update` /
  `input_audio_buffer.append` / `response.audio.delta`）
- 接口：`tau2/user/user_simulator_base.py` 的 `FullDuplexUser`（只要
  `get_init_state` + `get_next_chunk`）
- 音频：`tau2/voice/audio_native/audio_converter.py`（8 kHz μ-law ↔ PCM16）

<h2>线程模型</h2>

tau2 的 tick 是同步的，WebSocket 是异步的。所以起一条后台线程跑 asyncio 循环，
主线程用两个队列跟它交互：`_to_api` 送音频/指令，`_from_api` 收音频与转写。
一个 tick = 送 tick 长度的音频、收这一段时间里产生的所有事件。
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import queue
import re
import threading
from typing import Any, Optional, Tuple

from tau2.data_model.audio import TELEPHONY_AUDIO_FORMAT, AudioFormat
from tau2.data_model.message import AssistantMessage, EnvironmentMessage, UserMessage
from tau2.environment.tool import Tool
from tau2.user.user_simulator_base import FullDuplexUser, UserState
from tau2.voice.audio_native.audio_converter import pcm16_to_telephony, telephony_to_pcm16

#: 顾客的默认端点。这是用户给的 qwen-audio-3.1 那条；换成 `qwen3.5-omni-plus-realtime`
#: 只要改环境变量 `TAU2_QWEN_REALTIME_URL`（两条协议相同）。
DEFAULT_URL = (
    "wss://cn-beijing.maas.qianwenaiapi.com/api-ws/v1/realtime"
    "?model=qwen-audio-3.1-realtime-flash"
)
#: 顾客说出这些就当作挂断（τ² 的 STOP token 只有文本形态）
_FAREWELL = re.compile(r"那就这样|就这样吧|没别的事|没事了|再见|谢谢，?拜拜")
DEFAULT_VOICE = "longanqian"
#: 上行送 16k PCM16（API 固定），下行收 24k PCM16（API 固定）
INPUT_RATE = 16_000
OUTPUT_RATE = 24_000

#: 顾客侧的系统提示：把它变成一个**只知道自己的事、不知道答案**的人。
#: 这段约束"扮演谁"，任务内容在 `instructions` 里。
CALLER_SYSTEM = """你是一个打电话求助的普通用户。你只知道自己的情况，不知道对方系统的任何内部信息。
规则：
- 用口语说话，一次说一两句，不要长篇大论。
- 有问题就追问；对方问你要什么信息就如实回答。
- 对方说的和你掌握的情况矛盾时，指出来。
- 事情办完了、或者你不想办了，就说"那就这样吧"然后结束。
- 不要念出你的任务描述，也不要提到"任务""场景""测试"这些词。
"""


class QwenUserState(UserState):
    """对话状态：消息之外，还要记住"上一 tick 之后 API 说了什么"。

    `UserState` 是 pydantic 模型，所以这里的字段必须是 pydantic 认得的类型 ——
    音频缓冲用 `bytes`（不可变，切片不会留悬挂引用），重采样器状态用 `Any`。
    """

    tick: int = 0
    #: 已收到、还没交付给 orchestrator 的顾客音频（PCM16 24k）
    pending_audio: bytes = b""
    #: 这一 tick 里顾客说的话（交给 tick 的转写）
    pending_transcript: str = ""
    #: 顾客是否说过话
    spoke_at_least_once: bool = False
    #: 重采样状态：跨 chunk 保留，否则每个 chunk 边界都会有咔哒声
    in_state: Any = None
    out_state: Any = None


class QwenRealtimeUser(FullDuplexUser):
    """端到端实时的顾客模拟器（收音频、出声、自带 VAD）。"""

    STOP_TOKEN = "###STOP###"

    def __init__(
        self,
        instructions: Optional[str] = None,
        tools: Optional[list[Tool]] = None,
        *,
        api_key: Optional[str] = None,
        url: Optional[str] = None,
        voice: Optional[str] = None,
        audio_format: AudioFormat = TELEPHONY_AUDIO_FORMAT,
        log: Optional[Any] = None,
    ) -> None:
        super().__init__(instructions=instructions, tools=tools)
        self.api_key = api_key or os.environ.get("DASHSCOPE_API_KEY", "")
        if self.api_key == "":
            raise RuntimeError("QwenRealtimeUser 需要 DASHSCOPE_API_KEY")
        self.url = url or os.environ.get("TAU2_QWEN_REALTIME_URL", DEFAULT_URL)
        self.voice = voice or os.environ.get("TAU2_QWEN_VOICE", DEFAULT_VOICE)
        self.audio_format = audio_format
        self.log = log

        self._to_api: queue.Queue = queue.Queue()
        self._from_api: queue.Queue = queue.Queue()
        self._thread: Optional[threading.Thread] = None
        self._ready = threading.Event()
        self._error: Optional[str] = None
        self._tick_seconds = 1.0
        self._heard_bytes = 0

    # ------------------------------------------------------------ 日志

    def _say(self, line: str) -> None:
        if self.log is not None:
            self.log(line)

    # ------------------------------------------------------------ 生命周期

    def set_tick_duration(self, seconds: float) -> None:
        """orchestrator 的 tick 粒度（秒）。音频按它切片，默认 1 s。"""
        self._tick_seconds = seconds

    def _ensure_started(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._run_loop, name="qwen-realtime-user", daemon=True,
        )
        self._thread.start()
        if not self._ready.wait(timeout=25):
            raise RuntimeError(f"Qwen 实时会话没建起来：{self._error or '超时'}")
        if self._error is not None:
            raise RuntimeError(f"Qwen 实时会话失败：{self._error}")

    def close(self) -> None:
        if self._thread is None:
            return
        self._to_api.put(None)
        self._thread.join(timeout=5)
        self._thread = None

    def _run_loop(self) -> None:
        try:
            asyncio.run(self._ws_main())
        except Exception as e:  # noqa: BLE001 —— 子线程里没人接，必须落地
            self._error = f"{type(e).__name__}: {e}"
            self._say(f"[顾客] ✗ 连接异常 {self._error}")
            self._ready.set()

    async def _ws_main(self) -> None:
        import websockets

        persona = CALLER_SYSTEM
        if self.instructions:
            persona = f"{CALLER_SYSTEM}\n\n你的情况：\n{self.instructions}"

        async with websockets.connect(
            self.url,
            additional_headers={"Authorization": f"Bearer {self.api_key}"},
            max_size=16 << 20,
        ) as ws:
            await ws.send(json.dumps({
                "type": "session.update",
                "session": {
                    "modalities": ["text", "audio"],
                    "voice": self.voice,
                    "instructions": persona,
                    "input_audio_format": "pcm16",
                    "output_audio_format": "pcm16",
                    "turn_detection": {
                        "type": "server_vad",
                        "threshold": 0.5,
                        "silence_duration_ms": 500,
                    },
                },
            }))
            # 必须先等到 session.updated 再发别的东西：Qwen 会把「会话还没就绪时」
            # 收到的事件直接丢掉，`conversation.item.create` 掉了就会表现为
            # 「180 秒没有用户输入」—— 而不是报错。
            deadline = asyncio.get_running_loop().time() + 15
            while asyncio.get_running_loop().time() < deadline:
                left = deadline - asyncio.get_running_loop().time()
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=left)
                except asyncio.TimeoutError:
                    raise RuntimeError("15s 内没等到 session.updated") from None
                event = json.loads(raw)
                kind = event.get("type", "")
                if kind in ("session.created", "session.updated"):
                    session = event.get("session") or {}
                    self._say(
                        f"[顾客] {kind} instructions={len(str(session.get('instructions') or ''))}字 "
                        f"voice={session.get('voice')!r}"
                    )
                    if kind == "session.updated":
                        break
                elif kind == "error":
                    raise RuntimeError(f"session.update 被拒：{event.get('error')}")
            self._ready.set()
            await asyncio.gather(self._pump_out(ws), self._pump_in(ws))

    async def _pump_out(self, ws) -> None:
        while True:
            item = await asyncio.to_thread(self._to_api.get)
            if item is None:
                await ws.close()
                return
            if item["type"] == "audio":
                await ws.send(json.dumps({
                    "type": "input_audio_buffer.append",
                    "audio": base64.b64encode(item["data"]).decode(),
                }))
            elif item["type"] == "event":
                event_type = item["event"].get("type")
                self._say(f"[顾客] → {event_type}")
                await ws.send(json.dumps(item["event"]))

    async def _pump_in(self, ws) -> None:
        async for raw in ws:
            event = json.loads(raw)
            kind = event.get("type", "")
            if kind == "response.audio.delta":
                self._from_api.put(("audio", base64.b64decode(event["delta"])))
            elif kind in ("response.audio_transcript.delta", "response.text.delta"):
                self._from_api.put(("transcript", event.get("delta", "")))
            elif kind == "conversation.item.input_audio_transcription.completed":
                self._from_api.put(("heard", event.get("transcript", "")))
            elif kind == "error":
                self._from_api.put(("error", json.dumps(event.get("error", {}), ensure_ascii=False)[:200]))
            elif kind in ("session.created", "session.updated"):
                session = event.get("session") or {}
                self._say(
                    f"[顾客] {kind} instructions={len(str(session.get('instructions') or ''))}字 "
                    f"voice={session.get('voice')!r}"
                )

    # ------------------------------------------------------------ 接口

    def kick(self, instructions: Optional[str] = None) -> None:
        """让顾客主动开口。

        实时模型只在「听到东西」时才回应，而电话接通时对面还没说话 —— 所以要先在
        会话里放一条**自己**的消息（Qwen 明确拒绝空会话上的 `response.create`：
        `conversation has no messages or no user message`），再要一轮回复。
        `instructions` 会**整段覆盖**会话人设（OpenAI 语义），传了它模型就不知道
        自己是谁了 —— 一般不要传，人设交给 `session.update`。
        """
        self._to_api.put({
            "type": "event",
            "event": {
                "type": "conversation.item.create",
                "item": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "（电话接通了）"}],
                },
            },
        })
        event: dict = {"type": "response.create"}
        if instructions:
            event["response"] = {"instructions": instructions}
        self._to_api.put({"type": "event", "event": event})
        self._say("[顾客] kick 已排队")

    def get_init_state(self, message_history: Optional[list] = None) -> QwenUserState:
        self._ensure_started()
        return QwenUserState(
            system_messages=[],
            messages=list(message_history or []),
        )

    def get_next_chunk(
        self,
        state: QwenUserState,
        participant_chunk: Optional[AssistantMessage] = None,
        tool_results: Optional[EnvironmentMessage] = None,
    ) -> Tuple[UserMessage, QwenUserState]:
        state.tick += 1

        # 1) 对方这一 tick 说的话送进去：8k μ-law → 16k PCM16
        #    判据只看 `audio_content` 有没有内容 —— `is_audio` 在 tau2 里是按文本内容判的，
        #    对纯音频回合会给出 False（实测 tick=21 有 2668B 音频但 is_audio=False）。
        if participant_chunk is not None and participant_chunk.audio_content:
            ulaw = base64.b64decode(participant_chunk.audio_content)
            pcm16, state.in_state = telephony_to_pcm16(ulaw, INPUT_RATE, state.in_state)
            if pcm16:
                self._to_api.put({"type": "audio", "data": pcm16})
                self._heard_bytes += len(pcm16)
        if state.tick % 20 == 1:
            chunk_info = "无"
            if participant_chunk is not None:
                chunk_info = (
                    f"audio={participant_chunk.is_audio} "
                    f"len={len(participant_chunk.audio_content or '')} "
                    f"fmt={participant_chunk.audio_format}"
                )
            print(
                f"[顾客] tick={state.tick} 对方chunk[{chunk_info}] 已转给Qwen {self._heard_bytes}B "
                f"自身待送 {len(state.pending_audio)}B",
                flush=True,
            )

        # 2) 收这一 tick 的产出
        while True:
            try:
                kind, payload = self._from_api.get_nowait()
            except queue.Empty:
                break
            if kind == "audio":
                state.pending_audio += payload
            elif kind == "transcript":
                state.pending_transcript += payload
            elif kind == "heard":
                self._say(f"[顾客听到] {payload}")
            elif kind == "error":
                self._say(f"[顾客] ✗ {payload}")

        # 3) 按 tick 长度切一段交出去：24k PCM16 → 8k μ-law
        want = int(OUTPUT_RATE * 2 * self._tick_seconds)
        chunk = state.pending_audio[:want]
        state.pending_audio = state.pending_audio[len(chunk) :]
        telephony = b""
        if chunk:
            telephony, state.out_state = pcm16_to_telephony(chunk, OUTPUT_RATE, state.out_state)
            state.spoke_at_least_once = True

        message = UserMessage.voice(
            content=state.pending_transcript or None,
            audio_content=base64.b64encode(telephony).decode() if telephony else None,
            audio_format=self.audio_format,
            contains_speech=bool(telephony),
        )
        # τ² 靠文本 STOP token 判定"这通电话结束了"。语音里没有 token，只能从转写认：
        # 顾客说出告别语就把这一轮标成 STOP，否则整场只能靠墙钟超时切断、判分直接给 0。
        if message.content and _FAREWELL.search(message.content):
            message.content = self.STOP_TOKEN
        state.pending_transcript = ""
        if message.content:
            state.messages.append(message)
        return message, state
