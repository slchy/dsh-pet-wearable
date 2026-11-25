/**
 * 静态热词、识别语言、日期。CLI 和评测沙盒共用，不读进程级单例。
 */
import { readFileSync } from 'node:fs';

import { mergeCorpusText } from '../qwen-realtime-asr.ts';

/**
 * ASR 语言。默认中文。
 *
 * `auto` / `off` / 空串（含只含空白）表示不写 `language` 字段，让服务端自己判。
 * 其它非空值 trim 后原样返回。
 */
export function resolveAsrLanguage(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = env['QWEN_ASR_LANGUAGE'];
  if (raw === undefined) return 'zh';
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'auto' || trimmed === 'off') return undefined;
  return trimmed;
}

/**
 * 仓根 `docs/hotwords.txt` 与记忆热词收成一条静态 corpus。
 *
 * `QWEN_ASR_CORPUS=0` 关掉。文件读不到就当没有热词，不抛。
 */
export function loadStaticAsrCorpus(
  memoryHints = '',
  env: Record<string, string | undefined> = process.env,
): string {
  if (env['QWEN_ASR_CORPUS'] === '0') return '';
  let hotwordsText = '';
  try {
    hotwordsText = readFileSync(new URL('../../docs/hotwords.txt', import.meta.url), 'utf8');
  } catch {
    hotwordsText = '';
  }
  return mergeCorpusText([hotwordsText, memoryHints], 800);
}

/**
 * 建连时写进提示词的日期。只有年月日和星期，没有钟点：
 * 长连接不会因为「现在几点」过几小时就过期。
 *
 * `Intl.DateTimeFormat#format` 会把「日」和「星期」粘在一起，这里按字段重拼，
 * 中间留一个空格。
 */
export function formatCurrentDateContext(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'long',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `当前日期：${value('year')}年${value('month')}月${value('day')}日 ${value('weekday')}（北京时间）`;
}
