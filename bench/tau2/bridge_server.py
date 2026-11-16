"""把 tau2 的 `Environment` 暴露成本地 HTTP 口，给 dsh 的 MCP 工具回程用。

<h2>为什么需要这一层</h2>

τ² 的判分是「工具真在 `Environment` 里执行 → 最后按数据库状态核对」。而 dsh 的工具
是它自己进程里经 MCP 跑的。两边要接上，只有一条路：**bench 进程持有 `Environment`，
把工具表和调用口暴露出来**，dsh 侧再挂一个瘦 MCP server 转发。

所以工具**只在 bench 进程里执行一次**，dsh 不重复执行 —— 这也正是我们要的：dsh 的
工具调用落到的就是打分用的那个环境。

<h2>为什么是 stdlib 的 http.server</h2>

同机回环、每回合几次调用，不值得为它引 fastapi/uvicorn。`ThreadingHTTPServer` +
一把锁足够，而且它不会和 tau2 自己的 event loop 抢线程。
"""
from __future__ import annotations

import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

from tau2.data_model.message import ToolCall
from tau2.environment.environment import Environment

log = logging.getLogger("tau2-bridge")


class ToolBridge:
    """`Environment` 的只读工具表 + 唯一的调用入口。"""

    def __init__(self, environment: Environment) -> None:
        self._env = environment
        self._lock = threading.Lock()
        self.calls: list[dict[str, Any]] = []

    def tools(self) -> list[dict[str, Any]]:
        out = []
        for tool in self._env.get_tools():
            # tau2 的 schema 是 OpenAI 的 function 形态：name/description/parameters 都在 function 里
            fn = tool.openai_schema["function"]
            out.append(
                {
                    "name": fn["name"],
                    "description": fn.get("description") or "",
                    "inputSchema": fn.get("parameters") or {"type": "object", "properties": {}},
                }
            )
        return out

    def call(self, name: str, arguments: dict[str, Any], requestor: str = "assistant") -> dict[str, Any]:
        with self._lock:
            tool_call = ToolCall(
                id=f"bridge-{len(self.calls) + 1}",
                name=name,
                arguments=arguments or {},
                requestor=requestor,  # type: ignore[arg-type]
            )
            message = self._env.get_response(tool_call)
            entry = {
                "name": name,
                "arguments": arguments or {},
                "content": message.content,
                "error": bool(getattr(message, "error", False)),
            }
            self.calls.append(entry)
        log.info(
            "工具 %s(%s) → %s",
            name,
            json.dumps(entry["arguments"], ensure_ascii=False)[:200],
            (entry["content"] or "")[:160],
        )
        return {"content": entry["content"], "isError": entry["error"]}


def make_bridge_server(bridge: ToolBridge, host: str = "127.0.0.1", port: int = 0) -> ThreadingHTTPServer:
    """起一个后台线程的 HTTP 服务；返回 server（`.server_address[1]` 是实际端口）。"""

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003 —— 走我们自己的 logger
            log.debug("%s - %s", self.address_string(), fmt % args)

        def _send(self, status: int, payload: Any) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/health":
                self._send(200, {"ok": True, "calls": len(bridge.calls)})
            elif self.path == "/tools":
                self._send(200, {"tools": bridge.tools()})
            elif self.path == "/calls":
                self._send(200, {"calls": bridge.calls})
            else:
                self._send(404, {"error": f"未知路径 {self.path}"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/call":
                self._send(404, {"error": f"未知路径 {self.path}"})
                return
            length = int(self.headers.get("Content-Length") or "0")
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
                result = bridge.call(
                    str(payload["name"]),
                    payload.get("arguments") or {},
                    str(payload.get("requestor") or "assistant"),
                )
            except Exception as exc:  # noqa: BLE001 —— 工具报错要让模型看见，不能吞
                self._send(200, {"content": f"Error: {exc}", "isError": True})
                return
            self._send(200, result)

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, name="tau2-bridge", daemon=True).start()
    log.info("工具桥已监听 http://%s:%d", host, server.server_address[1])
    return server


def environment_for_domain(domain: str, *, load_file: Optional[str] = None) -> Environment:
    """按域名（airline / retail / telecom）建一个干净的 `Environment`。"""
    from tau2.registry import registry

    factory = registry.get_env_constructor(domain)
    return factory(load_file) if load_file else factory()
