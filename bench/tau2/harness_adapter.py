"""τ²-bench 的「被测方」适配器：把 dsh 的语音链路伪装成一台设备接进去。

<h2>它在链路里的位置</h2>

```
tau2 orchestrator ──tick 250ms──┐
                                ▼
                        HarnessAdapter  ←── 这个文件
                                │  8k μ-law 上行 → 16k PCM16（20 ms 一帧，按墙钟节拍送）
                                │  24k PCM16 下行 → 8k μ-law
                                ▼
                     dsh（src/main.ts --listen）──STT/TTS/判停──▶ 模型
```

dsh 以为自己在跟一台眼镜说话，其实对面是 τ² 的 tick 调度器。这样测到的就是**真实的**
判停、ASR、TTS 和首字延迟，而不是拿一段录音跑离线评测。

<h2>为什么不实现 `_flush_pending_tool_results`</h2>

工具**不在 dsh 这边回传**：dsh 经 `mcp__tau2__*` 自己调 MCP，工具在 bench 进程的
`Environment` 里执行（见 [bridge_server.py](./bridge_server.py)）。所以 orchestrator
永远收不到 `tool_calls`，也就不会重复执行。这是刻意的 —— 判分看的是那个 Environment
的最终状态。
"""
from __future__ import annotations

import json
import socket
import ssl
import struct
import threading
import time
from dataclasses import dataclass
from typing import Any, Optional

from tau2.data_model.audio import TELEPHONY_AUDIO_FORMAT, AudioFormat
from tau2.voice.audio_native.adapter import DiscreteTimeAdapter
from tau2.voice.audio_native.async_loop import BackgroundAsyncLoop
from tau2.voice.audio_native.tick_result import TickResult
from tau2.voice.audio_native.audio_converter import pcm16_to_telephony, telephony_to_pcm16

HEADER = 5
UP_AUDIO = 1
UP_HELLO = 6
DOWN_AUDIO = 1
DOWN_CONTROL = 2
DOWN_CALL = 3
DOWN_WELCOME = 4
DOWN_PONG = 5

#: 上行一块 20 ms（16 kHz / mono / 16 bit = 640 B），与实时节奏一致
CHUNK_BYTES = 640
CHUNK_MS = 20
#: dsh 的上行采样率固定 16 kHz；下行跟 TTS，CosyVoice / mimo 都是 24 kHz
UPLINK_RATE = 16_000
DOWNLINK_RATE = 24_000

#: PCM16 的「有声音」门限（约 -46 dBFS）。顾客是合成音，静音段是真静音，这个阈值抓得住。
VOICE_RMS = 300


def _rms(pcm16: bytes) -> float:
    """一块 PCM16 的 RMS。用来找「顾客说完」那一刻 —— 服务端的判停/分句都晚于它。"""
    if len(pcm16) < 2:
        return 0.0
    total = 0
    count = 0
    for i in range(0, len(pcm16) - 1, 2):
        sample = int.from_bytes(pcm16[i : i + 2], "little", signed=True)
        total += sample * sample
        count += 1
    return (total / count) ** 0.5 if count else 0.0


CAPABILITIES = {    "audioIn": "pcm16",
    "capture": {},
    "presence": False,
    "power": False,
    "summon": False,
    "listenStart": False,
    "played": False,
    "ignorePhrases": [],
}


@dataclass
class HarnessConfig:
    host: str = "127.0.0.1"
    port: int = 8766
    token: Optional[str] = None
    device_id: str = "tau2-bench"
    #: 等 `Welcome` 的上限；dsh 起来要连模型和侧车，放宽一点
    welcome_timeout_s: float = 30.0
    downlink_rate: int = DOWNLINK_RATE
    #: dsh 在 127.0.0.1 上也只给 TLS（自签），所以默认走 tls
    tls: bool = True
    #: 把每一帧的收发都打出来（排查时序问题用，正常跑关掉）
    trace: bool = False


@dataclass
class _Frame:
    kind: int
    payload: bytes
    at: float


class HarnessAdapter(DiscreteTimeAdapter):
    """dsh 一侧的 wire 协议客户端 + τ² 的 tick 语义。"""

    def __init__(
        self,
        config: HarnessConfig,
        *,
        tick_duration_ms: int = 250,
        audio_format: Optional[AudioFormat] = None,
    ) -> None:
        super().__init__(
            tick_duration_ms=tick_duration_ms,
            audio_format=audio_format or TELEPHONY_AUDIO_FORMAT,
        )
        self.config = config
        self._sock: Optional[socket.socket] = None
        self._reader: Optional[threading.Thread] = None
        self._frames: list[_Frame] = []
        self._frames_lock = threading.Lock()
        self._welcome = threading.Event()
        self._closing = threading.Event()
        self._loop = BackgroundAsyncLoop()
        self._in_state: Any = None
        self._out_state: Any = None
        self._uplink_carry = b""
        #: 每个 tick 的下行音频是否真的播过（用来判断 dsh 有没有开口）
        self.spoke_in_tick = False
        self._stat_uplink = 0
        self._stat_downlink = 0
        self._stat_controls = 0
        self._stat_ulaw = 0
        #: 客户端侧延迟打点：上行最后一次「有声音」的时刻 → 收到的第一个下行帧
        self._last_voice_at = 0.0
        self._utterance_end_at = 0.0
        self._voice_seen = False
        self._silence_since = 0.0
        self._t0_wall = 0.0
        self._t0_mono = 0.0
        self._local_port = 0
        self._lat_anchor = 0.0
        self._tick_no = 0
        self.latencies: list[dict] = []

    # ------------------------------------------------------------ 生命周期

    def connect(self, system_prompt: str, tools: list, vad_config: Any, modality: str = "audio") -> None:
        """连 dsh。

        `system_prompt` / `tools` 故意不用：dsh 的人设与工具来自它的 profile（工具经
        `mcp__tau2__*` 注入，人设见 `run_voice.py` 里写 MEMORY.md 的那段）。
        """
        del system_prompt, tools, vad_config, modality
        if self._sock is not None:
            return
        sock = socket.create_connection((self.config.host, self.config.port), timeout=15)
        if self.config.tls:
            # dsh 自己的证书是自签的；同机回环上不校验证书（我们只关心不被中间人冒充到
            # 别处，而这条连接根本没出本机）
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            sock = context.wrap_socket(sock, server_hostname=self.config.host)
        sock.settimeout(None)
        self._sock = sock
        # 打点用「距连接开始的毫秒」：档案里的 `t` 也是这个口径，两边才能逐轮对上，
        # 不必拿两个中位数相减（那样会把不同轮的分布混在一起）。
        self._t0_wall = time.time()
        self._t0_mono = time.monotonic()
        try:
            self._local_port = sock.getsockname()[1]
        except OSError:
            self._local_port = 0
        self._reader = threading.Thread(target=self._read_loop, name="dsh-wire-reader", daemon=True)
        self._reader.start()
        hello = {
            "proto": 2,
            "deviceId": self.config.device_id,
            "capabilities": CAPABILITIES,
        }
        if self.config.token:
            hello["token"] = self.config.token
        self._write(UP_HELLO, json.dumps(hello).encode("utf-8"))
        if not self._welcome.wait(self.config.welcome_timeout_s):
            raise RuntimeError(f"dsh 没回 Welcome（{self.config.welcome_timeout_s:.0f}s）")
        self._loop.start()

    def disconnect(self) -> None:
        if self.latencies:
            import os
            from pathlib import Path

            out = Path(os.environ.get("TAU2_LAT_OUT", "/tmp/tau2-lat.json"))
            out.write_text(json.dumps(self.latencies), encoding="utf-8")
            print(f"[lat] {len(self.latencies)} 轮写入 {out}", flush=True)
        self._closing.set()
        self._loop.stop()
        if self._sock is not None:
            try:
                self._sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self._sock.close()
            self._sock = None

    @property
    def is_connected(self) -> bool:
        return self._sock is not None and not self._closing.is_set()

    # ------------------------------------------------------------ wire

    def _write(self, kind: int, payload: bytes) -> None:
        if self._sock is None:
            return
        self._sock.sendall(struct.pack("<BI", kind, len(payload)) + payload)

    def _read_loop(self) -> None:
        buf = b""
        while not self._closing.is_set():
            try:
                chunk = self._sock.recv(65536) if self._sock is not None else b""
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
            while len(buf) >= HEADER:
                kind, length = struct.unpack("<BI", buf[:HEADER])
                if len(buf) < HEADER + length:
                    break
                payload = buf[HEADER : HEADER + length]
                buf = buf[HEADER + length :]
                self._on_frame(kind, payload)

    def _on_frame(self, kind: int, payload: bytes) -> None:
        if kind == DOWN_WELCOME:
            if self.config.trace:
                print(f"← Welcome {payload[:120]!r}", flush=True)
            self._welcome.set()
            return
        if kind == DOWN_PONG:
            return
        if kind == DOWN_CONTROL:
            text = payload.decode("utf-8", "replace")
            if self.config.trace:
                print(f"← Control {text[:200]}", flush=True)
        elif kind == DOWN_CALL:
            text = payload.decode("utf-8", "replace")
            if self.config.trace:
                print(f"← Call {text[:200]}", flush=True)
        elif kind == DOWN_AUDIO and self._utterance_end_at > self._lat_anchor:
            # 一轮只记第一次：顾客说完（连续 300 ms 静音）→ 客户端收到首个下行音频
            self._lat_anchor = self._utterance_end_at
            now = time.monotonic()
            ms = round((now - self._utterance_end_at) * 1000)
            self.latencies.append({
                "ms": ms,
                "tick": self._tick_no,
                "port": self._local_port,
                # 与档案对齐用「距连接开始的毫秒」—— 必须用同一个单调时钟做基准，
                # 拿 monotonic 减 wall clock 会得到无意义的负数。
                "anchor_at": round((self._utterance_end_at - self._t0_mono) * 1000),
                "first_at": round((now - self._t0_mono) * 1000),
            })
            print(f"[lat] 说完→首字节 {ms} ms", flush=True)
        with self._frames_lock:
            self._frames.append(_Frame(kind, payload, time.monotonic()))

    # ------------------------------------------------------------ tick

    def run_tick(self, user_audio: bytes, tick_number: Optional[int] = None) -> TickResult:
        tick = 0 if tick_number is None else tick_number
        return self._loop.run_coroutine(self._async_run_tick(user_audio, tick), timeout=60.0)

    async def _execute_tick(self, user_audio: bytes, tick_number: int, result: TickResult, tick_start: float) -> None:
        """送这一 tick 的顾客音频（8k μ-law → 16k PCM16），收这一 tick 的下行音频。"""
        import asyncio

        pcm16, self._in_state = telephony_to_pcm16(user_audio, UPLINK_RATE, self._in_state)
        self._uplink_carry += pcm16
        sent = 0
        self._tick_no = tick_number
        while len(self._uplink_carry) - sent >= CHUNK_BYTES:
            chunk = self._uplink_carry[sent : sent + CHUNK_BYTES]
            self._write(UP_AUDIO, chunk)
            sent += CHUNK_BYTES
            if _rms(chunk) >= VOICE_RMS:
                self._voice_seen = True
                self._silence_since = 0.0
            elif self._voice_seen and self._silence_since == 0.0:
                self._silence_since = time.monotonic()
            elif self._voice_seen and (time.monotonic() - self._silence_since) >= 0.3:
                # 连续 300 ms 静音才算"说完"：只取最后一个有声帧会把插话算成 0 ms
                self._utterance_end_at = self._silence_since
                self._voice_seen = False
                self._silence_since = 0.0
            await asyncio.sleep(CHUNK_MS / 1000)
        self._uplink_carry = self._uplink_carry[sent:]

        with self._frames_lock:
            frames, self._frames = self._frames, []
        down = bytearray()
        controls: list[str] = []
        for frame in frames:
            if frame.kind == DOWN_AUDIO:
                down.extend(frame.payload)
            elif frame.kind == DOWN_CONTROL:
                controls.append(frame.payload.decode("utf-8", "replace"))

        if down:
            ulaw, self._out_state = pcm16_to_telephony(bytes(down), self.config.downlink_rate, self._out_state)
            if ulaw:
                result.agent_audio_chunks.append((ulaw, f"dsh-t{tick_number}"))
                self.spoke_in_tick = True
                self._stat_ulaw += len(ulaw)
        if controls:
            result.events.extend(controls)

        self._stat_uplink += len(user_audio)
        self._stat_downlink += len(down)
        self._stat_controls += len(controls)
        if tick_number % 20 == 0:
            # 每 5 秒一行：上行/下行/控制帧。没有这一行就分不清"顾客没说话"和"dsh 没回话"
            print(
                f"[wire] t={tick_number} 上行 {self._stat_uplink}B 下行 {self._stat_downlink}B "
                f"交给 tick {self._stat_ulaw}B 控制帧 {self._stat_controls} 个",
                flush=True,
            )

    async def _flush_pending_tool_results(self) -> None:
        # 工具由 dsh 自己经 MCP 调用，这里没有要回传的东西（见模块 docstring）
        return
