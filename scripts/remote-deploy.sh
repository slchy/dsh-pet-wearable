#!/usr/bin/env bash
#
# 服务器端原子部署 + 探活 + 自动回滚。
#
# 由 `.github/workflows/deploy.yml` 通过 `ssh ... bash remote-deploy.sh` 调用；
# 也可以人肉在服务器上跑（一次性热部署 / 回滚）。**本脚本不联网、不拉代码**：
# 部署包由调用方先上传，这里只负责解压、挂共享资产、切软链、重启、探活。
#
# 目录形态（`$DEPLOY_PATH`）：
#
#   releases/<release-id>/   ← 每次部署一份完整代码
#   shared/.env              ← 持久化资产，部署**永远不覆盖**
#   shared/models/
#   shared/tokens.txt
#   shared/MEMORY.md
#   shared/archives/
#   shared/certs/
#   shared/announce.jsonl
#   current -> releases/<release-id>
#
# 红线：
#
#   - `.env`、`models/*.onnx`、`tokens.txt`、证书私钥、`MEMORY.md`、`archives/`、
#     `announce.jsonl` 只从 `shared/` **软链进来**，绝不写回 `shared/`；
#   - 切换只用 `ln -sfn` 到临时名 + `mv -Tf`，不做「先删后建」的中间态；
#   - 探活失败回滚到上一个 `current`，并打印最近日志（日志里没有 `.env`）。
#
# 本文件必须保持 LF 行尾（见 .gitattributes）：CRLF 会让 heredoc / 续行在 Linux 上失效。

set -euo pipefail

die() {
  printf 'remote-deploy: %s\n' "$1" >&2
  exit "${2:-1}"
}

# ---------------------------------------------------------------- 参数与环境

: "${DEPLOY_PATH:?DEPLOY_PATH 必填（部署根目录，例如 /opt/dsh-pet-wearable）}"
: "${DEPLOY_SERVICE:?DEPLOY_SERVICE 必填（systemd 单元名）}"
: "${RELEASE_ID:?RELEASE_ID 必填（本次发布的唯一标识）}"
: "${BUNDLE_PATH:?BUNDLE_PATH 必填（已上传的 .tar.gz）}"

DEPLOY_HEALTH_PORT="${DEPLOY_HEALTH_PORT:-}"
DEPLOY_KEEP_RELEASES="${DEPLOY_KEEP_RELEASES:-5}"
DEPLOY_EXTRA_SERVICES="${DEPLOY_EXTRA_SERVICES:-}"
SKIP_NPM_CI="${SKIP_NPM_CI:-0}"
HEALTH_WAIT_SEC="${HEALTH_WAIT_SEC:-6}"

# 去掉尾部斜杠，但保留根 `/` 以便下面统一拒绝。
while [ "${DEPLOY_PATH}" != "/" ] && [ "${DEPLOY_PATH%/}" != "${DEPLOY_PATH}" ]; do
  DEPLOY_PATH="${DEPLOY_PATH%/}"
done

case "${DEPLOY_PATH}" in
  /*) ;;
  *) die "DEPLOY_PATH 必须是绝对路径（收到 ${DEPLOY_PATH}）" ;;
esac

case "/${DEPLOY_PATH}/" in
  */../*) die "DEPLOY_PATH 不允许包含 ..（收到 ${DEPLOY_PATH}）" ;;
esac

case "${DEPLOY_PATH}" in
  / | /root | /etc | /usr | /bin | /sbin | /lib | /lib64 | /boot | /dev | /proc | /sys | /var | /tmp | /home | /opt | /srv | /run)
    die "DEPLOY_PATH 指向系统危险目录（${DEPLOY_PATH}），拒绝部署"
    ;;
esac

case "${RELEASE_ID}" in
  *[!A-Za-z0-9._-]*) die "RELEASE_ID 只能包含字母、数字、点、下划线与连字符（收到 ${RELEASE_ID}）" ;;
esac

case "${DEPLOY_SERVICE}" in
  *[!A-Za-z0-9@._-]*) die "DEPLOY_SERVICE 含非法字符（收到 ${DEPLOY_SERVICE}）" ;;
esac

# 附加服务名在解压 / 切软链之前就逐项校验，避免跑到一半才发现写错。
for extra_svc in $(printf '%s' "${DEPLOY_EXTRA_SERVICES}" | tr ',' ' '); do
  [ -n "${extra_svc}" ] || continue
  case "${extra_svc}" in
    *[!A-Za-z0-9@._-]*) die "DEPLOY_EXTRA_SERVICES 含非法字符（收到 ${extra_svc}）" ;;
  esac
done

case "${HEALTH_WAIT_SEC}" in
  '' | *[!0-9]*) HEALTH_WAIT_SEC=6 ;;
esac
case "${DEPLOY_KEEP_RELEASES}" in
  '' | *[!0-9]*) DEPLOY_KEEP_RELEASES=5 ;;
esac

if [ -n "${DEPLOY_HEALTH_PORT}" ]; then
  case "${DEPLOY_HEALTH_PORT}" in
    *[!0-9]*) die "DEPLOY_HEALTH_PORT 必须是数字（收到 ${DEPLOY_HEALTH_PORT}）" ;;
  esac
  if [ "${DEPLOY_HEALTH_PORT}" -lt 1 ] || [ "${DEPLOY_HEALTH_PORT}" -gt 65535 ]; then
    die "DEPLOY_HEALTH_PORT 超出 1..65535（收到 ${DEPLOY_HEALTH_PORT}）"
  fi
fi

[ -f "${BUNDLE_PATH}" ] || die "部署包不存在：${BUNDLE_PATH}"

# ---------------------------------------------------------------- 目录形态检查

# 老形态是「代码、.env、models 全在 $DEPLOY_PATH 根下」。直接按新形态部署会把
# `.env` 留在原地、让新的 release 读不到它（或更糟：把根目录当成 shared 覆盖）。
if [ ! -d "${DEPLOY_PATH}/shared" ] && [ -f "${DEPLOY_PATH}/.env" ]; then
  cat >&2 <<'EOF'
remote-deploy: 检测到旧版「原地部署」目录（部署根目录下有 .env，但没有 shared/）。
这次拒绝覆盖，因为新布局要求 .env / models / tokens.txt 等持久资产放在 shared/ 下。

请按 docs/CD.md「从原地目录迁移到 shared/ + current」一节完成迁移：
  1. 停服务（sudo systemctl stop <服务名>）；
  2. 把整个旧目录移成 releases/legacy；
  3. 把 .env / models / tokens.txt / MEMORY.md / archives / certs / announce.jsonl
     移进 shared/；
  4. 在 releases/legacy 里为这些项目建软链，再把 current 指向它；
  5. 确认 systemd 的 WorkingDirectory 是 <部署路径>/current，然后重新跑本脚本。

迁移完成前不会动任何现有文件。
EOF
  exit 2
fi

mkdir -p "${DEPLOY_PATH}/releases" "${DEPLOY_PATH}/shared"

RELEASE_DIR="${DEPLOY_PATH}/releases/${RELEASE_ID}"

# 切软链之前的任何失败（tar / npm ci）都清掉半成品目录，避免 releases/ 堆积残缺版本。
PRE_SWITCH=1
cleanup_pre_switch() {
  local status=$?
  if [ "${PRE_SWITCH}" = "1" ] && [ -n "${RELEASE_DIR:-}" ]; then
    echo "remote-deploy: 切换前失败，清理半成品 ${RELEASE_DIR}" >&2
    rm -rf -- "${RELEASE_DIR}"
  fi
  exit "${status}"
}
trap cleanup_pre_switch EXIT

# 同名目录可能是上一次中断留下的半成品：先清掉再解压。
rm -rf -- "${RELEASE_DIR}"
mkdir -p "${RELEASE_DIR}"

# DEPLOY_PATH 本身可能经过符号链接；清理旧版本时比对解析后的真实路径。
RELEASE_DIR_REAL="$(readlink -f "${RELEASE_DIR}" 2>/dev/null || printf '%s' "${RELEASE_DIR}")"

# ---------------------------------------------------------------- 解压与共享资产

echo "remote-deploy: 解压 ${BUNDLE_PATH} → ${RELEASE_DIR}"
tar -xzf "${BUNDLE_PATH}" -C "${RELEASE_DIR}"

# 只「从 shared 链进来」，绝不反向写 shared。
for item in .env models tokens.txt MEMORY.md archives certs announce.jsonl; do
  if [ -e "${DEPLOY_PATH}/shared/${item}" ] || [ -L "${DEPLOY_PATH}/shared/${item}" ]; then
    rm -rf -- "${RELEASE_DIR:?}/${item}"
    ln -sfn "${DEPLOY_PATH}/shared/${item}" "${RELEASE_DIR}/${item}"
    echo "  shared/${item} → release"
  fi
done

if [ "${SKIP_NPM_CI}" != "1" ]; then
  echo "remote-deploy: npm ci --omit=dev"
  ( cd "${RELEASE_DIR}" && npm ci --omit=dev --no-audit --no-fund )
fi

# ---------------------------------------------------------------- 切软链与回滚

PREV_TARGET="$(readlink -f "${DEPLOY_PATH}/current" 2>/dev/null || true)"

switch_current() {
  local target="$1"
  ln -sfn "${target}" "${DEPLOY_PATH}/current.tmp"
  mv -Tf "${DEPLOY_PATH}/current.tmp" "${DEPLOY_PATH}/current"
}

rollback() {
  local reason="$1"
  echo "remote-deploy: 失败：${reason}" >&2
  if [ -n "${PREV_TARGET}" ] && [ -d "${PREV_TARGET}" ] && [ "${PREV_TARGET}" != "${RELEASE_DIR_REAL}" ]; then
    echo "remote-deploy: 回滚 current → ${PREV_TARGET}" >&2
    switch_current "${PREV_TARGET}"
    sudo -n systemctl restart "${DEPLOY_SERVICE}" || true
  else
    echo "remote-deploy: 没有可回滚的历史版本（首次部署）" >&2
  fi
  echo "remote-deploy: 最近 40 行日志（journalctl，不含 .env）：" >&2
  if ! sudo -n journalctl -u "${DEPLOY_SERVICE}" -n 40 --no-pager; then
    journalctl -u "${DEPLOY_SERVICE}" -n 40 --no-pager || true
  fi
  exit 1
}

echo "remote-deploy: 切换 current → ${RELEASE_DIR}"
PRE_SWITCH=0
switch_current "${RELEASE_DIR}"

echo "remote-deploy: 重启 ${DEPLOY_SERVICE}"
if ! sudo -n systemctl restart "${DEPLOY_SERVICE}"; then
  rollback "systemctl restart 失败"
fi

# ---------------------------------------------------------------- 探活

FIRST_WAIT=2
if [ "${HEALTH_WAIT_SEC}" -lt "${FIRST_WAIT}" ]; then
  FIRST_WAIT="${HEALTH_WAIT_SEC}"
fi
sleep "${FIRST_WAIT}"
if ! sudo -n systemctl is-active --quiet "${DEPLOY_SERVICE}"; then
  rollback "服务在 ${FIRST_WAIT}s 内未处于 active（可能启动即崩溃）"
fi

REMAINING=$((HEALTH_WAIT_SEC - FIRST_WAIT))
if [ "${REMAINING}" -gt 0 ]; then
  sleep "${REMAINING}"
fi
if ! sudo -n systemctl is-active --quiet "${DEPLOY_SERVICE}"; then
  rollback "服务在 ${HEALTH_WAIT_SEC}s 内退出（疑似 crash-loop）"
fi

check_port() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | awk 'NR > 1 { print $4 }' | grep -Eq "[:.]${port}\$"; then
      return 0
    fi
  fi
  if command -v nc >/dev/null 2>&1; then
    if nc -z 127.0.0.1 "${port}" >/dev/null 2>&1; then
      return 0
    fi
  fi
  if command -v node >/dev/null 2>&1; then
    if node --input-type=module -e '
      import net from "node:net";
      const port = Number(process.argv[1]);
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.on("connect", () => { socket.end(); process.exit(0); });
      socket.on("error", () => process.exit(1));
      setTimeout(() => process.exit(1), 1500);
    ' "${port}"; then
      return 0
    fi
  fi
  return 1
}

if [ -n "${DEPLOY_HEALTH_PORT}" ]; then
  echo "remote-deploy: 探活 127.0.0.1:${DEPLOY_HEALTH_PORT}"
  if ! check_port "${DEPLOY_HEALTH_PORT}"; then
    rollback "端口 ${DEPLOY_HEALTH_PORT} 未监听"
  fi
fi

# ---------------------------------------------------------------- 附加服务

if [ -n "${DEPLOY_EXTRA_SERVICES}" ]; then
  for svc in $(printf '%s' "${DEPLOY_EXTRA_SERVICES}" | tr ',' ' '); do
    [ -n "${svc}" ] || continue
    echo "remote-deploy: 重启附加服务 ${svc}"
    if ! sudo -n systemctl restart "${svc}"; then
      rollback "附加服务 ${svc} 重启失败"
    fi
    if ! sudo -n systemctl is-active --quiet "${svc}"; then
      rollback "附加服务 ${svc} 未处于 active"
    fi
  done
fi

# ---------------------------------------------------------------- 清理历史版本

if [ "${DEPLOY_KEEP_RELEASES}" -gt 0 ] && [ -d "${DEPLOY_PATH}/releases" ]; then
  shopt -s nullglob
  entries=("${DEPLOY_PATH}"/releases/*/)
  shopt -u nullglob
  if [ "${#entries[@]}" -gt 0 ]; then
    mapfile -t sorted < <(ls -1dt -- "${entries[@]}" 2>/dev/null || true)
    index=0
    for dir in "${sorted[@]}"; do
      index=$((index + 1))
      if [ "${index}" -le "${DEPLOY_KEEP_RELEASES}" ]; then
        continue
      fi
      abs="$(readlink -f "${dir}" 2>/dev/null || printf '%s' "${dir}")"
      if [ "${abs}" = "${RELEASE_DIR_REAL}" ]; then
        continue
      fi
      if [ -n "${PREV_TARGET}" ] && [ "${abs}" = "${PREV_TARGET}" ]; then
        continue
      fi
      echo "remote-deploy: 清理旧版本 ${dir}"
      rm -rf -- "${dir}"
    done
  fi
fi

active="$(sudo -n systemctl is-active "${DEPLOY_SERVICE}" 2>/dev/null || true)"
echo "remote-deploy: 完成 —— ${DEPLOY_SERVICE} 状态 ${active}，current → ${RELEASE_DIR}"
