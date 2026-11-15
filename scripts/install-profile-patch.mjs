/**
 * 把仓库里的 profile patch 装到本机 dsh 的 sdk profile 永久层。
 *
 * 人设提示词现在只存在 `mcp/profile.cordis.yml` 里 —— 本地不装这份 patch，
 * 跑起来就是一个**没有任何人设**的通用 agent，调试时看到的行为和线上完全不同。
 *
 * 服务器上由 `scripts/deploy_cloud.py` 自动安装，本地开发跑一次这个即可。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../mcp/profile.cordis.yml', import.meta.url));
const dst = join(homedir(), '.dsh', 'profiles', 'sdk', 'cordis.patch.yml');

if (!existsSync(src)) {
  console.error(`找不到 ${src}`);
  process.exit(1);
}

mkdirSync(dirname(dst), { recursive: true });
copyFileSync(src, dst);
console.log(`profile patch 已安装：${dst}`);
console.log('人设提示词随之生效；改 mcp/profile.cordis.yml 后要重跑一次这个脚本。');
