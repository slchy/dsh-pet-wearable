#!/usr/bin/env bash
# 客户端口径重测：跑一场 bench，然后出「说完→首字节」的 p50/p90/p95。
#
#   bash bench-lat-run.sh [任务id] [墙钟上限秒]
#   COSYVOICE_TRACE=1 bash bench-lat-run.sh 17_zh_identity 60     # 带 TTS 探针
#
# 产物：
#   /tmp/bench-lat-<任务>.log     run_voice.py 的输出（含 dsh 日志尾部）
#   /tmp/dsh-bench.log            harness 的 stdout（每场覆盖）
#   /tmp/tau2-lat-<任务>.json     客户端打点；汇总时**所有任务的打点一起算**，
#                                 想只看这一场就先 rm -f /tmp/tau2-lat-*.json
#   /tmp/tau2-sim-<任务>.json     SimulationRun 全量（reward、对话记录）
#
# 环境变量（都有默认值）：
#   TAU2_DSH_DIR   harness 部署目录，默认 ~/miai-cloud（读它的 .env）
#   TAU2_PYTHON    装了 tau2 的 python，默认 ~/miai-bench/tau2-bench/.venv/bin/python
#   VOICE_PIPELINE 调用方在 source .env 之前显式指定的管道；不设则钉死 cascade
#   TAU2_STT       显式指定 STT。live 且没设它时才补 --stt qwen-realtime
set -u
TASK="${1:-18_zh_identity}"
SECS="${2:-150}"
DSH_DIR="${TAU2_DSH_DIR:-$HOME/miai-cloud}"
PYTHON="${TAU2_PYTHON:-$HOME/miai-bench/tau2-bench/.venv/bin/python}"

# 脚本可能是从别处软链过来的；其余 bench 脚本都在它真实所在的目录
cd "$(dirname "$(readlink -f "$0")")" || exit 1

# 上一场没收尾的 bench harness。只认 bench 的端口，别按裸数字匹配 —— 那会误杀
# 命令行里恰好带这串数字的无关进程。
pkill -f -- '--listen 8766'

# 调用方显式给的 VOICE_PIPELINE 必须在 source .env **之前**抄走。
# .env 里的 VOICE_PIPELINE=live（或 OMNI_SHADOW=1 + OMNI_ANSWER=full）配 tau2
# 默认的 --stt aliyun，main.ts 会直接退出。没指定就钉死 cascade。
CALLER_PIPELINE="${VOICE_PIPELINE:-}"

set -a
. "$DSH_DIR/.env"
set +a
export TAU2_PIPELINE="${CALLER_PIPELINE:-cascade}"
export TAU2_DSH_TOKEN="$(cat /tmp/bench-token.txt)"
# SimulationRun 不叫 tau2-lat-*：那个前缀是打点文件专用的，汇总脚本按它通配。
# 以前叫 tau2-lat-sim.json，汇总时被当成打点读进去，每场都崩在 r['ms'] 上。
export TAU2_SIM_OUT="/tmp/tau2-sim-${TASK}.json"
export TAU2_LAT_OUT="/tmp/tau2-lat-${TASK}.json"
rm -f "$TAU2_LAT_OUT" /tmp/tau2-lat.json /tmp/tau2-lat-sim.json

# cascade 不传 --stt，沿用 run_voice.py 的默认 aliyun。
# live 必须 qwen-realtime；调用方已经用 TAU2_STT（或事先写进参数的 --stt）指定过就别改写。
run_args=(
  --domain retail
  --task-id "$TASK"
  --max-steps 200
  --timeout "$SECS"
  --spawn-dsh
  --pipeline "$TAU2_PIPELINE"
)
if [ -n "${TAU2_STT:-}" ]; then
  run_args+=(--stt "$TAU2_STT")
fi
if [ "$TAU2_PIPELINE" = "live" ]; then
  case " ${run_args[*]} " in
    *" --stt "*) ;;
    *) run_args+=(--stt qwen-realtime) ;;
  esac
fi

timeout $((SECS + 60)) "$PYTHON" run_voice.py "${run_args[@]}" \
  > "/tmp/bench-lat-${TASK}.log" 2>&1
CODE=$?
# run_voice.py：0 = reward 非零，1 = reward 为 0（**不是崩了**），2 = 没取到任务或管道/STT 不配，124 = 超时被杀
echo "run_voice 退出码 $CODE（1 表示 reward=0，不是崩溃）"
grep -E '^=== |工具调用' "/tmp/bench-lat-${TASK}.log"

python3 lat_summary.py
