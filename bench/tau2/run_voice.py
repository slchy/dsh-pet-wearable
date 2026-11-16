"""跑一题中文语音 τ²-bench：**被测方是 dsh**，顾客是 Qwen realtime。

<h2>装配方式</h2>

不自己拼环境/多语种绑定 —— 那些在 `build_voice_orchestrator` 里和在制品校验（artifact
pins）绑得很紧，重写一遍很容易静默跑成英文。做法是**只换两个零件**：

```python
B.build_agent = ...   # → DiscreteTimeAudioNativeAgent(adapter=HarnessAdapter(...))
B.build_voice_user = ...  # → QwenRealtimeUser(...)
```

其余（任务的 zh 译文、Environment、CallContext、tick 参数、判分）全走 tau2 自己的路径。

<h2>三个进程/线程的关系</h2>

```
run_voice.py
 ├─ ToolBridge + HTTP 8799        ← dsh 的 mcp__tau2__* 工具回程
 ├─ QwenRealtimeUser              ← 顾客（自带 VAD，会插话）
 ├─ HarnessAdapter ──TCP──▶ dsh   ← 被测方（另起进程，见 README）
 └─ FullDuplexOrchestrator         ← tick 调度 + 最后按环境状态判分
```

前置：dsh 必须先起来，并且只挂 tau2 的 MCP：

```bash
DSH_PATCH=<repo>/mcp/tau2-bench.yml TAU2_BRIDGE_URL=http://127.0.0.1:8799 \\
  node src/main.ts --listen 8766 --stt aliyun --tts mimo --agent dsh --dsh-sdk
```
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from tau2.data_model.run_config import AudioNativeConfig
from tau2.data_model.simulation import VoiceRunConfig
from tau2.runner.simulation import run_simulation
import tau2.runner.build as builder

from bridge_server import ToolBridge, make_bridge_server
from harness_adapter import HarnessAdapter, HarnessConfig
from qwen_realtime_user import QwenRealtimeUser

#: 工具桥默认端口；dsh 那边靠 `TAU2_BRIDGE_URL` 找过来，两边要一致
DEFAULT_BRIDGE_PORT = 8799
DEFAULT_DSH_PORT = 8766

log = logging.getLogger("run-voice")


def patch_builders(tick_ms: int, dsh_port: int, dsh_token: str | None) -> None:
    """把 tau2 的 agent/user 工厂换成我们的两件。"""
    from tau2.agent.discrete_time_audio_native_agent import DiscreteTimeAudioNativeAgent

    def build_agent(name: str, environment, **kwargs):  # noqa: ANN001, ANN202 —— 签名要对齐 tau2
        del name, kwargs
        adapter = HarnessAdapter(
            HarnessConfig(port=dsh_port, token=dsh_token),
            tick_duration_ms=tick_ms,
        )
        return DiscreteTimeAudioNativeAgent(
            tools=environment.get_tools(),
            domain_policy=environment.get_policy(),
            tick_duration_ms=tick_ms,
            adapter=adapter,
        )

    def build_voice_user(environment, prompt, config, **kwargs):  # noqa: ANN001, ANN202
        del environment, config, kwargs
        return QwenRealtimeUser(instructions=prompt, log=lambda line: log.info("%s", line))

    builder.build_agent = build_agent
    builder.build_voice_user = build_voice_user


def spawn_dsh(work_dir: Path, port: int, bridge_port: int, stt: str, tts: str) -> "subprocess.Popen[str]":
    """拉起一个**只服务本次 bench** 的 dsh（不动生产那个 63993）。"""
    import socket as _socket
    import subprocess
    import time

    repo = Path(os.environ.get("TAU2_DSH_DIR") or Path.home() / "miai-cloud")
    patch = repo / "mcp" / "tau2-bench.yml"
    if not patch.exists():
        raise RuntimeError(f"缺 patch：{patch}")
    work_dir.mkdir(parents=True, exist_ok=True)
    # 会话指针必须是 bench 自己的一份，而且**每场从空会话开始**：
    # - 不隔离：默认路径是 ~/.voice-agent/session.json，和生产共用，bench 会把生产的
    #   会话 id 盖掉（实测踩过）；
    # - 不清空：上一场的对话留在上下文里，模型一开口就接着上一个任务说，reward 不可信。
    # 放在 work_dir **旁边**而不是里面：沙箱允许 agent 写 work_dir 内的一切（见 session.ts）。
    session_file = work_dir.parent / f"{work_dir.name}.session.json"
    session_file.unlink(missing_ok=True)
    log.info("dsh 会话指针 %s（每场清空）", session_file)
    env = {
        **os.environ,
        "DSH_PATCH": str(patch),
        "TAU2_BRIDGE_URL": f"http://127.0.0.1:{bridge_port}",
        "VOICE_AGENT_SESSION": str(session_file),
        # 离线播报队列同理：默认也在 ~/.voice-agent/ 下，bench 攒的话会被生产补播出去。
        # 空串 = 不持久化（见 main.ts）。
        "MIAI_ANNOUNCE_FILE": "",
    }
    log_path = Path("/tmp/dsh-bench.log")
    log_file = log_path.open("w", encoding="utf-8")
    proc = subprocess.Popen(  # noqa: S603 —— 参数是我们自己拼的，无 shell
        [
            os.environ.get("TAU2_NODE", "node"),
            str(repo / "src" / "main.ts"),
            "--listen", str(port),
            "--stt", stt,
            "--tts", tts,
            "--agent", "dsh",
            "--dsh-sdk",
            "--work-dir", str(work_dir),
        ],
        cwd=str(repo),
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        text=True,
    )
    proc.dsh_log = str(log_path)  # type: ignore[attr-defined]
    proc.dsh_log_file = log_file  # type: ignore[attr-defined]
    deadline = time.time() + 90
    while time.time() < deadline:
        if proc.poll() is not None:
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-1200:]
            raise RuntimeError(f"dsh 起不来：\n{tail}")
        try:
            with _socket.create_connection(("127.0.0.1", port), timeout=1):
                log.info("dsh 已监听 %d", port)
                return proc
        except OSError:
            time.sleep(1)
    proc.kill()
    raise RuntimeError(f"dsh 90s 内没监听 {port}")


def write_policy_for_dsh(policy: str, language: str) -> Path | None:
    """把该域的政策写进 dsh 的 `MEMORY.md`。

    dsh 每轮把 `MEMORY.md` 注入系统提示词（见 `mcp/camera.yml` 的
    `agent-instructions`），所以这是给被测方"喂政策"的现成通道 —— 不用改 dsh 代码。
    """
    target = os.environ.get("TAU2_DSH_MEMORY")
    if not target:
        return None
    path = Path(target)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"# 本次来电的业务规则（{language}，来自 τ²-bench）\n\n"
        "**每一条事实都必须先用工具查证，不许凭印象回答。**"
        "工具名以 `mcp__tau2__` 开头（如 `mcp__tau2__get_order_details`），"
        "该域的全部工具都在那里；没有调工具就说“已办妥”一律算错。\n\n"
        f"{policy}\n",
        encoding="utf-8",
    )
    return path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", default="retail", choices=["retail", "airline", "telecom"])
    ap.add_argument("--task-id", default=None)
    ap.add_argument("--language", default="zh")
    ap.add_argument("--tick-ms", type=int, default=250)
    ap.add_argument("--max-steps", type=int, default=120)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--dsh-port", type=int, default=DEFAULT_DSH_PORT)
    ap.add_argument("--dsh-token", default=os.environ.get("TAU2_DSH_TOKEN"))
    ap.add_argument("--bridge-port", type=int, default=DEFAULT_BRIDGE_PORT)
    ap.add_argument("--list-tasks", action="store_true", help="只列任务，不跑")
    ap.add_argument("--spawn-dsh", action="store_true", help="由本方拉起 dsh（否则连已有的）")
    ap.add_argument("--timeout", type=float, default=150.0, help="整场墙钟上限（秒），到点就收尾判分")
    ap.add_argument("--stt", default="aliyun")
    ap.add_argument("--tts", default="cosyvoice")
    ap.add_argument("--work-dir", default=None, help="dsh 工作目录（默认 /tmp/tau2-bench-work）")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # tau2 的 tick 日志走 loguru，一跑就是几千行；我们只看自己的日志
    try:
        from loguru import logger as _loguru

        _loguru.remove()
    except Exception:  # noqa: BLE001 —— 没装 loguru 就算了
        pass
    logging.getLogger("tau2").setLevel(logging.WARNING)

    if args.list_tasks:
        # 中文包有自己的一套任务（id 与英文不是同一套），要走语言绑定后再列
        from tau2.multilingual.runtime import pin_language_artifacts
        from tau2.runner.helpers import select_run_tasks

        bound = VoiceRunConfig(
            domain=args.domain,
            language=args.language,
            task_ids=[args.task_id] if args.task_id else None,
            audio_native_config=AudioNativeConfig(tick_duration_seconds=args.tick_ms / 1000),
        )
        bound_task_list = select_run_tasks(bound, pin_language_artifacts(bound))
        print(f"{args.domain}/{args.language}: {len(bound_task_list)} 题")
        for bound_task in bound_task_list[:8]:
            print(f"  {bound_task.id}: {str(bound_task.user_scenario)[:90]}")
        return 0

    config = VoiceRunConfig(
        domain=args.domain,
        language=args.language,
        task_ids=[args.task_id] if args.task_id else None,
        max_steps=args.max_steps,
        seed=args.seed,
        timeout=args.timeout,
        audio_native_config=AudioNativeConfig(tick_duration_seconds=args.tick_ms / 1000),
    )
    # 任务必须取自**语言绑定后**的那一套，否则 task_context 会报
    # "task does not match published language binding"
    from tau2.multilingual.runtime import pin_language_artifacts
    from tau2.runner.helpers import select_run_tasks

    bound_tasks = select_run_tasks(config, pin_language_artifacts(config))
    if not bound_tasks:
        print("语言绑定后没有任务", file=sys.stderr)
        return 2
    task = bound_tasks[0]

    patch_builders(args.tick_ms, args.dsh_port, args.dsh_token)
    orchestrator = builder.build_voice_orchestrator(config, task, seed=args.seed)
    # τ² 里顾客先开口（现实里也是对方打进来的）。Qwen realtime 不会自己开腔，
    # 必须显式要一轮 —— 否则整场都是静音，只能看着 tick 空转。
    orchestrator.user.kick()
    if hasattr(orchestrator.user, "set_tick_duration"):
        orchestrator.user.set_tick_duration(args.tick_ms / 1000)

    # 政策喂给 dsh；同时把工具桥起起来，让 `mcp__tau2__*` 有落脚点
    work_dir = Path(args.work_dir or "/tmp/tau2-bench-work")
    os.environ.setdefault("TAU2_DSH_MEMORY", str(work_dir / "MEMORY.md"))
    policy_path = write_policy_for_dsh(orchestrator.environment.get_policy(), args.language)
    if policy_path is not None:
        log.info("政策已写入 dsh 的 %s", policy_path)
    bridge = ToolBridge(orchestrator.environment)
    server = make_bridge_server(bridge, port=args.bridge_port)
    log.info("工具桥 http://127.0.0.1:%d（%d 个工具）", server.server_address[1], len(bridge.tools()))

    dsh_proc = None
    if args.spawn_dsh:
        # 必须先有桥再有 dsh：dsh 的 MCP 在启动时就要拉工具表（failOnStartupError）
        dsh_proc = spawn_dsh(work_dir, args.dsh_port, args.bridge_port, args.stt, args.tts)

    log.info("开始：domain=%s task=%s tick=%dms 顾客=%s", args.domain, task.id, args.tick_ms, args.language)
    try:
        simulation = run_simulation(orchestrator)
    finally:
        agent = orchestrator.agent
        user = orchestrator.user
        for closer in (getattr(user, "close", None), getattr(getattr(agent, "adapter", None), "disconnect", None)):
            if callable(closer):
                try:
                    closer()
                except Exception as exc:  # noqa: BLE001 —— 收尾失败不该盖住结果
                    log.warning("收尾失败：%s", exc)
        server.shutdown()
        if dsh_proc is not None:
            dsh_proc.kill()
            log_path = Path(getattr(dsh_proc, "dsh_log", "/tmp/dsh-bench.log"))
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-1500:]
            log.info("dsh 日志尾部：\n%s", tail)

    reward = simulation.reward_info.reward if simulation.reward_info else None
    print(f"\n=== {args.domain}/{task.id} reward={reward} "
          f"ticks={len(orchestrator.get_ticks()) if hasattr(orchestrator, 'get_ticks') else '?'}")
    print(f"    工具调用 {len(bridge.calls)} 次：{[c['name'] for c in bridge.calls]}")
    out = Path(os.environ.get("TAU2_SIM_OUT") or f"results/{args.domain}-{task.id}.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(simulation.model_dump_json(indent=2), encoding="utf-8")
    print(f"    结果写入 {out}")
    return 0 if reward else 1


if __name__ == "__main__":
    raise SystemExit(main())

