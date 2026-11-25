/**
 * 判断「当前进程是不是把某个文件当成入口跑」。
 *
 * CLI、评测脚本各自传入自己的 `import.meta.url`。默认值比的是本模块，
 * 入口文件如果无参调用，比的就不是它自己。
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * `moduleUrl` 是不是这次进程的入口（`node that-file.ts`）？
 *
 * 为什么需要这道守卫：测试会 import 入口文件取纯函数，而顶层 `void main()`
 * 会当场打印用法并 `process.exit(2)` —— 整个测试进程直接死。
 *
 * 判据按 **URL** 比，不按字符串：`process.argv[1]` 可能是相对路径、盘符大小写也可能
 * 与 `import.meta.url` 不一致（Windows），所以两边都 realpath 再转 URL。
 * 不能只判「`argv[1]` 存在」：`node --test` 下它是测试文件，不是入口。
 */
export function isMainModule(entry = process.argv[1], moduleUrl = import.meta.url): boolean {
  if (entry === undefined || entry === '') {
    return false;
  }
  let entryUrl: string;
  try {
    entryUrl = pathToFileURL(realpathSync(entry)).href;
  } catch {
    // 文件不存在（打错/已删）时退回 resolve：比较结果同样可信
    entryUrl = pathToFileURL(resolve(entry)).href;
  }
  return normalizeFileUrl(entryUrl) === normalizeFileUrl(moduleUrl);
}

/** 盘符大小写、URL 里中文/空格的转义形式都可能不同，只比「像不像同一个文件」。 */
export function normalizeFileUrl(url: string): string {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // 非法转义：保持原样再比
  }
  return process.platform === 'win32' ? decoded.toLowerCase() : decoded;
}
