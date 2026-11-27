/**
 * 静态热词、识别语言、日期。CLI 和评测沙盒共用，不读进程级单例。
 */
import { readFileSync } from 'node:fs';

import { mergeCorpusText } from '../qwen-realtime-asr.ts';

/**
 * ASR 语言。**缺省不写 `language` 字段**，让模型按音频自己判。
 *
 * 早先默认 `'zh'`：中英混读时 `Bangumi` / `Live` 这类罗马音会被强拉成中文同音字，
 * 而识别器本身对中日英混说是能判的 —— 硬锁语言等于把它的能力关掉。
 *
 * `auto` / `off` / 空串（含只含空白）同样表示不写 `language` 字段。
 * 其它非空值 trim 后原样返回（`zh` / `en` / `yue` …）。
 */
export function resolveAsrLanguage(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = env['QWEN_ASR_LANGUAGE'];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'auto' || trimmed === 'off') return undefined;
  return trimmed;
}

/**
 * 整句高精度转写用的热词 corpus。
 *
 * 只在 VAD 确认有声、且这一轮要委派 `dsh` 的**整句**上进 `system` 上下文；
 * 因此不会踩到 `qwen3-asr-flash-realtime` 那个「静音封段复读整串热词」的 bug
 * （见 `qwen-realtime-asr.ts` 的 `isCorpusEcho`）。
 *
 * `VOICE_REFINE_ASR_CORPUS=0` 关掉。文件读不到就当没有热词，不抛 ——
 * `dsh-voice-web` 打包后没有 `docs/` 目录。
 */
export function loadRefineHotwords(
  memoryHints = '',
  env: Record<string, string | undefined> = process.env,
): string {
  if (env['VOICE_REFINE_ASR_CORPUS'] === '0') return '';
  let hotwordsText = '';
  try {
    hotwordsText = readFileSync(new URL('../../docs/hotwords.txt', import.meta.url), 'utf8');
  } catch {
    hotwordsText = '';
  }
  return mergeCorpusText([hotwordsText, memoryHints], 600);
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
