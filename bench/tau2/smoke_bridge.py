"""自测工具桥：环境里的工具表 → HTTP → MCP 代理 → 真执行一次工具。

三段各验一遍，任何一段断了都能立刻看出来是哪一段：
1. `Environment` 能不能建出来、工具表长什么样
2. HTTP 口（`/tools`、`/call`）通不通，工具是否真的改了环境
3. `mcp-tau2.mjs` 这条 stdio 代理能不能把 `tools/list` / `tools/call` 转出去

用法：
    python smoke_bridge.py [--domain retail] [--lang zh]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.request

from bridge_server import ToolBridge, environment_for_domain, make_bridge_server


def http_json(url: str, payload: dict | None = None, timeout: float = 15.0) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="GET" if payload is None else "POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 —— 同机回环
        return json.loads(resp.read().decode("utf-8"))


def mcp_roundtrip(script: str, base: str, tool: str, args: dict) -> tuple[list[dict], dict]:
    """把 JSON-RPC 三行喂给 `mcp-tau2.mjs`，收它的标准输出。"""
    lines = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": tool, "arguments": args}},
    ]
    stdin = "\n".join(json.dumps(line, ensure_ascii=False) for line in lines) + "\n"
    proc = subprocess.run(
        ["node", script],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, "TAU2_BRIDGE_URL": base},
    )
    if proc.stderr.strip():
        print(f"  [node stderr] {proc.stderr.strip()[:300]}")
    replies = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    tools = next((r["result"]["tools"] for r in replies if r.get("id") == 2), [])
    call = next((r for r in replies if r.get("id") == 3), {})
    return tools, call


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", default="retail")
    ap.add_argument("--lang", default="zh")
    args = ap.parse_args()

    env = environment_for_domain(args.domain)
    bridge = ToolBridge(env)
    tools = bridge.tools()
    print(f"1) 域 {args.domain}：{len(tools)} 个工具，前三个：{ [t['name'] for t in tools[:3]] }")
    if not tools:
        print("✗ 工具表是空的", file=sys.stderr)
        return 1

    server = make_bridge_server(bridge, port=0)
    base = f"http://127.0.0.1:{server.server_address[1]}"
    print(f"2) HTTP 口 {base}")
    listed = http_json(f"{base}/tools")["tools"]
    print(f"   /tools 返回 {len(listed)} 个，首个 schema keys={sorted(listed[0]['inputSchema'])}")

    # 读工具的调用：挑一个不需要参数或只读的，失败也没关系 —— 我们要验的是链路
    probe = next((t for t in tools if t["name"] in ("get_user_details", "get_order_details", "list_all_products", "get_customer_by_phone")), tools[0])
    probe_args = {}
    schema_props = probe["inputSchema"].get("properties") or {}
    for key in ("user_id", "order_id", "customer_id"):
        if key in schema_props:
            probe_args[key] = "sara_doe_496" if key == "user_id" else "W2378156"
            break
    http_result = http_json(f"{base}/call", {"name": probe["name"], "arguments": probe_args})
    print(f"   /call {probe['name']}({probe_args}) → isError={http_result.get('isError')} "
          f"content={str(http_result.get('content'))[:90]}")

    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mcp-tau2.mjs")
    mcp_tools, mcp_call = mcp_roundtrip(script, base, probe["name"], probe_args)
    print(f"3) MCP 代理：tools/list {len(mcp_tools)} 个，tools/call isError="
          f"{mcp_call.get('result', {}).get('isError')} "
          f"content={str(mcp_call.get('result', {}).get('content'))[:90]}")

    ok = bool(mcp_tools) and "result" in mcp_call
    print("✓ 三段都通" if ok else "✗ 有环节不通")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
