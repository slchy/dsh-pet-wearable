"""裸看 Qwen realtime 的事件流：确认 session.update 有没有被吃、人设有没有生效。

`session.created` / `session.updated` 会把**服务端实际生效的** session 打回来。
它里面 `instructions` 是空的，就说明我们那条 `session.update` 没被接受。
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys

URL = os.environ.get(
    "TAU2_QWEN_REALTIME_URL",
    "wss://cn-beijing.maas.qianwenaiapi.com/api-ws/v1/realtime"
    "?model=qwen-audio-3.1-realtime-flash",
)
PERSONA = "你是一个打电话求助的普通用户，家里的宽带断了，想问问什么时候能修好。用口语，一次说一两句。"


async def main() -> int:
    import websockets

    key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not key:
        print("需要 DASHSCOPE_API_KEY", file=sys.stderr)
        return 1

    async with websockets.connect(
        URL, additional_headers={"Authorization": f"Bearer {key}"}, max_size=16 << 20
    ) as ws:
        await ws.send(json.dumps({
            "type": "session.update",
            "session": {
                "modalities": ["text", "audio"],
                "instructions": PERSONA,
                "voice": "longanqian",
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "turn_detection": {"type": "server_vad", "threshold": 0.5, "silence_duration_ms": 500},
            },
        }))

        async def pump(seconds: float, label: str) -> None:
            end = asyncio.get_running_loop().time() + seconds
            while True:
                left = end - asyncio.get_running_loop().time()
                if left <= 0:
                    return
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=left)
                except asyncio.TimeoutError:
                    return
                ev = json.loads(raw)
                kind = ev.get("type", "")
                if kind in ("response.audio.delta",):
                    print(f"  [{label}] {kind} {len(ev.get('delta', ''))}B", flush=True)
                elif kind in ("session.created", "session.updated"):
                    s = ev.get("session", {})
                    print(
                        f"  [{label}] {kind} instructions={s.get('instructions')!r} "
                        f"voice={s.get('voice')!r} modalities={s.get('modalities')}",
                        flush=True,
                    )
                elif kind.startswith("response.audio_transcript") or kind in (
                    "response.text.delta", "response.audio_transcript.done",
                ):
                    print(f"  [{label}] {kind} {ev.get('delta') or ev.get('transcript')!r}", flush=True)
                else:
                    print(f"  [{label}] {kind} {json.dumps(ev, ensure_ascii=False)[:160]}", flush=True)

        print("== 1) 握手 3s ==", flush=True)
        await pump(3.0, "hs")

        print("== 2) 种一条 user 文本 + response.create 8s ==", flush=True)
        await ws.send(json.dumps({
            "type": "conversation.item.create",
            "item": {"type": "message", "role": "user",
                     "content": [{"type": "input_text", "text": "（电话接通了）"}]},
        }))
        await ws.send(json.dumps({"type": "response.create"}))
        await pump(8.0, "kick")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
