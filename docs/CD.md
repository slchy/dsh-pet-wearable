# CD 流水线（Release / npm / 服务器部署）

打一个 tag，自动完成四件事：跑全套闸门 → 打两份包 → 发 npm → 建 GitHub Release →
部署到云端。本文只写「怎么配、怎么用、怎么回滚」；机制细节在脚本注释里。

```
git push origin v1.2.3
        │
        ▼
┌─ release.yml ───────────────────────────────────────────────┐
│ gate      版本一致 + secrets/typecheck/formal/mutate/tests  │
│ pack      dsh-voice-web-<ver>.tgz                           │
│           dsh-pet-wearable-server-<ver>.tar.gz              │
│           SHA256SUMS.txt                                    │
│ publish   npm（Trusted Publishing 或 NPM_TOKEN，带 provenance）│
│ release   GitHub Release + 三个附件 + 自动 Release Notes     │
│ deploy    → deploy.yml                                      │
└─────────────────────────────────────────────────────────────┘
```

`deploy.yml` 也可以单独触发：指定任意 ref 做热部署，或填历史 tag 做回滚。

## 一、GitHub Environments

在 **Settings → Environments** 建两个环境。

### `npm`

| 项 | 值 |
|---|---|
| Deployment branches and tags | 只允许 tag：`v*`（或 `Selected tags` 里加 `v*.*.*`） |
| Required reviewers | 可选；想给发版加人工闸门就勾上 |
| Secrets | `NPM_TOKEN`（**可选**，见下一节） |

### `production`

| 项 | 值 |
|---|---|
| Deployment branches and tags | 只允许 tag `v*`（若常做 `main` 热部署，再加 `main`） |
| Required reviewers | **建议开启**：部署会重启线上服务 |
| Secrets | `DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`、`DEPLOY_KNOWN_HOSTS` |
| Variables | `DEPLOY_PATH`、`DEPLOY_SERVICE`、`DEPLOY_PORT`（可选）、`DEPLOY_HEALTH_PORT`、`DEPLOY_KEEP_RELEASES`、`DEPLOY_EXTRA_SERVICES` |

| 类型 | 名称 | 说明 |
|---|---|---|
| Secret | `DEPLOY_HOST` | 服务器地址（示例 `<服务器地址>`） |
| Secret | `DEPLOY_USER` | 部署专用 SSH 用户 |
| Secret | `DEPLOY_SSH_KEY` | 该用户的**私钥全文**（含首尾行） |
| Secret | `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan -H <服务器地址>` 的输出全文 |
| Variable | `DEPLOY_PATH` | 部署根目录，例如 `/opt/<应用名>` |
| Variable | `DEPLOY_SERVICE` | systemd 单元名，例如 `<应用名>` |
| Variable | `DEPLOY_PORT` | 可选；SSH 端口，缺省 `22` |
| Variable | `DEPLOY_HEALTH_PORT` | 可选；本机探活端口，例如 `8766` |
| Variable | `DEPLOY_KEEP_RELEASES` | 可选；保留最近几份，缺省 `5` |
| Variable | `DEPLOY_EXTRA_SERVICES` | 可选；逗号或空格分隔的附加服务名 |

要点：

- 私有仓库之外**不要**把上述任何值写进工作流或文档；示例里只有 `<占位符>`。
- `DEPLOY_KNOWN_HOSTS` 固定主机键。换机器/换主机键后必须同步更新，否则部署会以
  `Host key verification failed` 失败 —— 这是有意的，**不要**改成
  `StrictHostKeyChecking=no`。
- 建议给 `production` 开 Required reviewers：部署会重启线上服务。

## 二、npm 鉴权：二选一

### 方案 A：Trusted Publishing（推荐，无需长期 token）

1. npmjs.com → `dsh-voice-web` → **Settings → Trusted Publisher**；
2. 选 **GitHub Actions**，填写：
   - Organization/User：GitHub 组织或用户名
   - Repository：本仓库名
   - Workflow filename：`release.yml`
   - Environment：`npm`
3. 不配置 `NPM_TOKEN` 即可。工作流会检查 npm 版本，低于 `11.5.1` 时自动
   `npm install -g npm@latest`，然后用 OIDC 发布并附 provenance。

### 方案 B：Automation token

1. npmjs.com → Access Tokens → 生成 **Automation** token（只给这一个包的发权限）；
2. 存进 `npm` environment 的 Secret：`NPM_TOKEN`；
3. 工作流发现它非空就写入临时 `~/.npmrc`（退出时由 `trap` 立即删除），发布参数完全一致（同样带
   `--provenance`）。

两种方案都幂等：`npm view dsh-voice-web@<ver>` 已存在时直接跳过。

> 正式版发到 `latest`，`vX.Y.Z-beta.N` 发到 `next`。这样 beta 不会顶掉
> `npm install dsh-voice-web` 的默认版本。

## 三、服务器一次性准备

### 1. 专用用户 + SSH key

```bash
# 本地生成（不要设 passphrase，CI 无法交互）
ssh-keygen -t ed25519 -C 'dsh-cd' -f ./dsh_cd -N ''

# 服务器上为部署用户安装公钥
sudo useradd -m -s /bin/bash deploy
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
sudo sh -c 'cat dsh_cd.pub >> /home/deploy/.ssh/authorized_keys'
sudo chmod 600 /home/deploy/.ssh/authorized_keys
sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys
```

把 `dsh_cd` 私钥全文存进 `DEPLOY_SSH_KEY`。本地那份用完删掉。

### 2. known_hosts

```bash
ssh-keyscan -H <服务器地址> > known_hosts
# 如果 SSH 不在默认 22 端口：ssh-keyscan -H -p <端口> <服务器地址> > known_hosts
```

内容存进 `DEPLOY_KNOWN_HOSTS`。**不要**把这文件提交进仓库。

### 3. 最小 sudoers

部署脚本需要重启服务、查状态、看最近日志。只放行这几条，别给全量 sudo：

```bash
sudo visudo -f /etc/sudoers.d/dsh-deploy
```

```sudoers
# 路径以服务器上 `command -v systemctl` / `command -v journalctl` 为准
deploy ALL=(root) NOPASSWD: /bin/systemctl restart <服务名>, \
                            /bin/systemctl is-active <服务名>, \
                            /bin/systemctl is-active --quiet <服务名>, \
                            /usr/bin/journalctl -u <服务名> *
```

有 `DEPLOY_EXTRA_SERVICES` 时，把每个服务的 `restart` / `is-active` 两行也加上。
注意 `sudo` 是**按参数精确匹配**的：少写 `--quiet` 就会在探活那一步失败。

### 4. 目录形态与 systemd

部署脚本维护这个结构：

```
<DEPLOY_PATH>/
├── releases/<release-id>/   # 每次部署一份完整代码
├── shared/                  # 持久资产，部署永不覆盖
│   ├── .env
│   ├── models/
│   ├── tokens.txt
│   ├── MEMORY.md
│   ├── archives/
│   ├── certs/
│   └── announce.jsonl
└── current -> releases/<release-id>
```

systemd 单元把工作目录指向 `current`，环境文件指向 `shared/.env`（不随版本切换）：

```ini
[Service]
WorkingDirectory=<DEPLOY_PATH>/current
EnvironmentFile=<DEPLOY_PATH>/shared/.env
ExecStart=/usr/bin/env node src/main.ts --listen 8766
Restart=always
RestartSec=3
```

改完 `sudo systemctl daemon-reload`。

### 5. 从「原地部署」迁移到 shared/ + current

旧形态是代码、`.env`、`models` 全在 `<DEPLOY_PATH>` 根下。**部署脚本检测到
「没有 shared/ 但根下有 .env」会直接拒绝（退出码 2）**，不会覆盖任何东西。

一次性迁移（把 `<应用名>` 换成实际目录名）：

```bash
sudo systemctl stop <服务名>

cd <DEPLOY_PATH>/..
sudo mv <应用名> <应用名>-inplace
sudo mkdir -p <DEPLOY_PATH>/releases <DEPLOY_PATH>/shared

# 持久资产搬进 shared/
cd <应用名>-inplace
for item in .env models tokens.txt MEMORY.md archives certs announce.jsonl; do
  [ -e "$item" ] && sudo mv "$item" <DEPLOY_PATH>/shared/
done
cd ..

# 旧代码整体成为第一份 release，并让 current 指向它
sudo mv <应用名>-inplace <DEPLOY_PATH>/releases/legacy
sudo ln -sfn <DEPLOY_PATH>/releases/legacy <DEPLOY_PATH>/current

# 旧 release 里补上软链，保证迁移后立刻能启动
cd <DEPLOY_PATH>/releases/legacy
for item in .env models tokens.txt MEMORY.md archives certs announce.jsonl; do
  [ -e "<DEPLOY_PATH>/shared/$item" ] && sudo ln -sfn "<DEPLOY_PATH>/shared/$item" "$item"
done

sudo systemctl start <服务名>
```

确认服务正常后，手动触发一次 `Deploy`（ref 填 `main`）切到新布局。第一次部署成功后，
`releases/legacy` 会在清理旧版本时被保留到超出 `DEPLOY_KEEP_RELEASES` 为止。

> 迁移不会删除 `.env` / `models/*.onnx` / `tokens.txt` / 证书 / `MEMORY.md` /
> `archives/` / `announce.jsonl`；它们只在 `shared/` 里存在，部署包本身也**禁止**
> 包含这些文件（打包时就会失败）。

## 四、日常操作

### 发一个正式版

```bash
npm run version:bump 1.2.3     # 改两份 package.json + 两份 lockfile
npm run verify:release         # 本地打一次包并做清单/安装冒烟（可选但推荐）
git add package.json package-lock.json packages/dsh-voice-web/package.json \
        packages/dsh-voice-web/package-lock.json
git commit -m "release: v1.2.3"
git tag v1.2.3
git push origin main --follow-tags
```

预发布同理，版本写 `1.2.3-beta.1`，tag 写 `v1.2.3-beta.1`。

只想验证流程、不发布：Actions → Release → Run workflow，`dry_run` 保持 `true`。
它会跑完 gate 与 pack（含真包安装冒烟），然后停。

### 只部署服务端

Actions → **Deploy** → Run workflow：

| 输入 | 说明 |
|---|---|
| `ref` | 要部署的 tag / 分支 / SHA |
| `dry_run` | 只看打包结果与配置是否齐全，不连服务器 |
| `skip_npm_ci` | 依赖没变时跳服务器上的 `npm ci` |

它不会发 npm，也不建 Release。

### 回滚

**推荐**：Deploy → Run workflow，`ref` 填上一个正常版本的 tag。部署脚本会把
`current` 原子切到新解压的目录；探活失败会自动切回原来的 `current`。

**手动**（服务器上，仅紧急）：

```bash
cd <DEPLOY_PATH>
ls -1dt releases/*/                 # 挑一个要回的 release
sudo ln -sfn <DEPLOY_PATH>/releases/<旧id> current.tmp
sudo mv -Tf current.tmp current
sudo systemctl restart <服务名>
sudo systemctl is-active <服务名>
tail -n 40 <(sudo journalctl -u <服务名> --no-pager)
```

不要 `rm -rf current` 再建 —— 中间会有一段时间没有 `current`。

## 五、失败时看什么

| 现象 | 先看 |
|---|---|
| gate 失败 | `bump-version.mjs --check` 的报错：tag 与仓内版本不一致 |
| pack 失败 | 清单校验输出：缺哪个文件 / 混进哪个禁区文件 |
| npm 403 | `docs/CD.md` 上一节；Trusted Publisher 的 workflow / environment 是否写对 |
| npm 已发布、Release 失败 | 直接重跑工作流：npm 幂等跳过，Release 覆盖附件 |
| 部署 `Host key verification failed` | `DEPLOY_KNOWN_HOSTS` 过期；重新 `ssh-keyscan` |
| 部署后服务起不来 | 脚本已自动回滚并打印 40 行 journalctl；再查 `<DEPLOY_PATH>/shared/.env` |
| 迁移被拒绝（退出码 2） | 按第三节第 5 小节迁移到 `shared/` + `current` |
