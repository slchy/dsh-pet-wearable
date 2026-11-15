#!/bin/bash
# 调优时同时抓两端日志，按时间对齐。只在本机（或能 ssh 到服务器）跑。
#
#   ./scripts/watch-tune.sh            # 两端各抓 60 s
#   ./scripts/watch-tune.sh 180        # 抓 3 分钟
#
# 手机端靠 adb 已连上（`adb devices` 有设备）；服务端靠 ssh 上的 journalctl。
# 过滤掉每 3 秒一条的宠物心跳，那会把真正的事件冲走。
set -u

DURATION="${1:-60}"
ADB_SERIAL="${ADB_SERIAL:-<设备地址>:45107}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_HOST="${SSH_HOST:-root@127.0.0.1}"

OUT="${OUT:-tmp/tune-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"

echo "抓 ${DURATION}s → $OUT/"
echo "  手机 $ADB_SERIAL"
echo "  云端 $SSH_HOST"

# 手机端：App 自己的 tag + 崩溃
(timeout "$DURATION" adb -s "$ADB_SERIAL" logcat -v time MiaiglassSample:V AndroidRuntime:E '*:S' \
  > "$OUT/phone.log" 2>&1) &
PHONE=$!

# 云端：去掉心跳噪声
(timeout "$DURATION" ssh -i "$SSH_KEY" -o BatchMode=yes "$SSH_HOST" \
  "sudo -n journalctl -u miai-harness -f --no-pager" 2>/dev/null \
  | grep --line-buffered -vE '宠物 ← 心跳|心跳后仍不出声' \
  > "$OUT/cloud.log" 2>&1) &
CLOUD=$!

wait $PHONE $CLOUD 2>/dev/null

echo
echo "=== 手机（最后 20 行）"
tail -20 "$OUT/phone.log"
echo
echo "=== 云端（最后 20 行）"
tail -20 "$OUT/cloud.log"
echo
echo "完整日志：$OUT/phone.log  $OUT/cloud.log"
