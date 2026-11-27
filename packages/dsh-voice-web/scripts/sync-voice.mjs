/**
 * 把仓根 `src/` 同步一份到 `packages/dsh-voice-web/src/voice/`。
 *
 * 目标是「仓里只有一份源，包② 的 tarball 里是实体」，所以这份拷贝**不进 git**
 * （见 .gitignore），靠 `prepack` / `typecheck` 时重跑本脚本刷新。
 *
 * 为什么不软连接：实测 npm 11.16 的 packlist **直接跳过 symlink** ——
 * `files: ["src"]`、显式列 `src/voice`、`src/voice/**` 三种写法打出来的 tarball
 * 里都没有链接目标，本地能跑、发出去是空包。这条路不再考虑。
 *
 * 为什么是「排除法」而不是「只列需要的」：闭包会变。加一个新文件时若靠白名单，
 * 忘了登记就是运行时才炸的缺模块；靠黑名单则默认被带上，多带一个分析脚本无所谓。
 *
 * 黑名单 = 从 `main.ts` 出发的静态 import 闭包里够不到的那些（2026-11-17 实测时是 18 个）。
 * 它们要么是分析/标定工具，要么是模拟器，要么是包① 自己的插件入口。
 * 文件总数**不写死**：源目录随时会增删，下面的 `skipped` 由实际扫描结果算。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// 本脚本从仓根 `scripts/` 挪进了 `packages/dsh-voice-web/scripts/`（提交 c96cd56，
// 内容原样带过来）：仓根因此是**上三级**（scripts → dsh-voice-web → packages → 仓根）。
// 写成 `'..'` 会把包② 自己的 `src/` 当源目录、把目标铺成 `packages/dsh-voice-web/packages/...`。
const repo = resolve(here, '..', '..', '..');
const source = join(repo, 'src');
const dest = join(repo, 'packages', 'dsh-voice-web', 'src', 'voice');

/** 相对 `src/` 的路径，正斜杠结尾表示整个目录 */
const EXCLUDE = [
  // 包① 自己的 dsh 插件入口，与包② 的 driver 无关
  'driver.ts',
  // 一次性工具：时间线核对、延迟报告、设备配对
  'fsm-trace.ts',
  'latency-report.ts',
  'pair.ts',
  'pairing.ts',
  // 模拟器：虚拟时钟 + 声明式场景，纯离线验证用
  'pet/sim/',
];

const isExcluded = (rel) => {
  const posix = rel.replaceAll('\\', '/');
  return EXCLUDE.some((entry) => (entry.endsWith('/') ? posix.startsWith(entry) : posix === entry));
};

/** 递归收集要带上的文件（相对 source 的路径）。`applyExclude=false` 用来数源目录总数 */
function collect(dir, out = [], applyExclude = true) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = relative(source, abs);
    if (applyExclude && isExcluded(rel)) {
      continue;
    }
    if (statSync(abs).isDirectory()) {
      collect(abs, out, applyExclude);
    } else {
      out.push(rel);
    }
  }
  return out;
}

if (!existsSync(source)) {
  throw new Error(`找不到源目录 ${source}`);
}

const files = collect(source);
const total = collect(source, [], false).length;
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const rel of files) {
  const to = join(dest, rel);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join(source, rel), to);
}

const skipped = total - files.length;
console.log(`同步语音栈：${files.length} 个文件 → ${relative(repo, dest)}（源 ${total} 个，跳过 ${skipped}）`);

// LICENSE 只留仓根一份：npm 包必须带它，但复制品不进 git（见 .gitignore），
// 每次同步时从仓根覆盖，避免两份文本漂移。
const license = join(repo, 'LICENSE');
if (existsSync(license)) {
  cpSync(license, join(repo, 'packages', 'dsh-voice-web', 'LICENSE'));
  console.log('同步 LICENSE → packages/dsh-voice-web/LICENSE');
}
