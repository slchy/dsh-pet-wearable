"""冒烟：顾客能不能自己开口、我们能不能收到音频与转写。

只跑 10 个 tick（每 tick 1 s），对面全程不说话（`participant_chunk=None`），
用来确认三件事：会话建得起来、`kick()` 要得动一轮回复、音频/转写在 tick 里交得出来。
"""
from __future__ import annotations

import sys
import time

from qwen_realtime_user import QwenRealtimeUser


def main() -> int:
    user = QwenRealtimeUser(
        instructions="你家里的宽带昨天开始断了，想问问什么时候能修好。",
        log=lambda line: print(line, flush=True),
    )
    state = user.get_init_state()
    t0 = time.time()
    # 注意：不要往 kick() 里传 instructions —— 那会**整段覆盖**会话人设，
    # 模型会退回成"客服"口吻。人设只由 session.update 决定。
    user.kick()

    audio_total = 0
    transcript = ""
    try:
        for tick in range(1, 11):
            time.sleep(1.0)
            msg, state = user.get_next_chunk(state)
            audio_total += len(msg.audio_content or "")
            if msg.content:
                transcript += msg.content
            print(
                f"tick {tick:02d}  +{time.time() - t0:5.2f}s  "
                f"audio_b64={len(msg.audio_content or '')}B  "
                f"speech={msg.contains_speech}  text={msg.content!r}",
                flush=True,
            )
    finally:
        user.close()

    print(f"--- 合计 audio_b64={audio_total}B  transcript={transcript!r}")
    if audio_total == 0:
        print("✗ 顾客没出声", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
