/**
 * ASR 主语和 Omni 答复对不上时的听岔检测。
 *
 * 纯函数：不读盘、不发请求。只认「在问某个具体专名是什么」这种窄句型，
 * 再看答复是不是换了一个完全不重叠的实体在自信解释。
 * 闲聊、代词、诚实的「没听清」一律放过，免得把 S1 误派进后台。
 */

export interface SubjectHallucination {
  readonly subject: string;
  readonly replySubject: string;
}

/** 句首口语，剥掉之后才对得上「X 是什么」。单字「那」另判，避免把「那本书」剥成专名。 */
const LEAD_PREFIXES = ['再问一下', '请问', '那个', '帮我', '给我', '说说', '讲讲'] as const;

const LEAD_PUNCT = /^[\s，。！？、；：,.!?;:'"“”‘’「」『』【】（）()[\]…—～~·]+/u;

/** 「那本 / 那些 / 那里」是指代，不是专名前面的口头语。 */
const NA_DEMONSTRATIVE = /^那(?:些|本|个|部|种|边|里|次|回|句|位|名|天|儿|么)/u;

const ASK_INTRO = /^(?:介绍一下|讲一下|解释一下|科普一下)(.{2,14}?)[？?。！!]*$/u;

/** 口语外框：「你知道齐主是谁吗？」剥掉之后才对得上「X 是谁」。 */
const KNOW_PREFIXES = ['你听说过', '你听过', '你知道', '你了解'] as const;

const ASK_WHAT = /^(.{2,14}?)(?:是什么|是啥|讲(?:的|了)?什么|是谁|什么意思|讲啥)(?:吗|呢|呀|啊)?[？?。！!]*$/u;

/**
 * 「你知道 X 吗 / 你听说过 X 吗」这种窄句型。
 *
 * 只取外框里的整段主体，**不碰带疑问词或子句谓语的非专名从句**：
 * 「你知道怎么去机场吗」「你知道水多少度沸腾吗」「你知道你叫什么名字吗」
 * 都不是在问某个专名，抓出来派后台只会制造误报。
 */
const ASK_KNOW = /^(?:你)?(?:知道|听说过|听过|了解)(.{2,14}?)(?:吗|不|没|么)[？?。！!]*$/u;

const NON_NAME_CLAUSE = /怎么|为什么|多少|几|在哪|什么时候|会不会|能不能|是不是|有没有|叫什么/u;

const PRONOUN_START = /^(?:大家|刚才|刚刚|今天|明天|昨天|现在|外面|上面|下面|我|你|他|她|它|这|那|咱)/u;

const GENERIC_PHRASES = [
  '叫什么',
  '什么意思',
  '名字',
  '心情',
  '天气',
  '时候',
  '时间',
  '地方',
  '事情',
  '东西',
  '问题',
  '原因',
  '理由',
  '办法',
  '工作',
  '生活',
  '作品',
  '电影',
  '小说',
  '书',
  '话',
] as const;

const PRONOUN_PHRASES = [
  '大家',
  '刚才',
  '刚刚',
  '今天',
  '明天',
  '昨天',
  '现在',
  '外面',
  '上面',
  '下面',
  '我',
  '你',
  '他',
  '她',
  '它',
  '这',
  '那',
  '咱',
] as const;

const HONEST_REPLY = /没听清|听不清|听岔|哪本|哪部|哪个|再说一遍|再说一次|不太清楚|不确定|不了解|查一下|我查查|帮你查/u;

const DEFINITION_REPLY = /是|指|又称|代表作|随笔|小说|电影|作者|导演|概念|理论/u;

/** 书名号之外最多蹭到这么多核心字，仍当没在答这个专名。 */
const MAX_INCIDENTAL_OVERLAP = 0.25;

const PUNCT = /[\s，。！？、；：,.!?;:'"“”‘’「」『』【】（）()[\]…—～~·《》〈〉]/gu;

const FUNCTION_CHARS = /[的之个部本首篇叫么吗呀啊呢吧了]/gu;

function charCount(text: string): number {
  return [...text].length;
}

function lastChars(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return chars.slice(chars.length - max).join('');
}

function firstChars(text: string, max: number): string {
  return [...text].slice(0, max).join('');
}

function trimPunct(text: string): string {
  return text.replace(LEAD_PUNCT, '').replace(/[\s，。！？、；：,.!?;:'"“”‘’「」『』【】（）()[\]…—～~·《》〈〉]+$/u, '');
}

/** 去掉标点、空白和虚词后的实义字。重叠只比这些字。 */
function coreChars(text: string): string {
  return text.replace(PUNCT, '').replace(FUNCTION_CHARS, '');
}

function overlapCount(needle: string, haystack: string): number {
  if (needle === '' || haystack === '') return 0;
  const hay = new Set([...haystack]);
  let count = 0;
  for (const ch of needle) {
    if (hay.has(ch)) count += 1;
  }
  return count;
}

function stripLead(raw: string): string {
  let text = trimPunct(raw.trim());
  for (let guard = 0; guard < 8; guard += 1) {
    const next = trimPunct(text);
    if (next !== text) {
      text = next;
      continue;
    }
    let stripped = false;
    for (const prefix of LEAD_PREFIXES) {
      if (!text.startsWith(prefix)) continue;
      text = text.slice(prefix.length);
      stripped = true;
      break;
    }
    if (!stripped) break;
  }
  return text.trim();
}

function matchSubject(text: string): string | null {
  const intro = ASK_INTRO.exec(text);
  const introSubject = intro?.[1]?.trim();
  if (introSubject !== undefined && introSubject !== '') return introSubject;
  const what = ASK_WHAT.exec(text);
  const subject = what?.[1]?.trim();
  if (subject === undefined || subject === '') return null;
  return subject;
}

/** 剥掉「你知道 / 你听说过 / 你听过 / 你了解」外框，返回剩下的问句。 */
function stripKnowFrame(text: string): string {
  for (const prefix of KNOW_PREFIXES) {
    if (!text.startsWith(prefix)) continue;
    return trimPunct(text.slice(prefix.length));
  }
  return text;
}

/** 「你听说过 X 吗」的整段主体。带疑问词/子句谓语的从句不是专名，直接放过。 */
function matchKnowSubject(text: string): string | null {
  const know = ASK_KNOW.exec(text);
  const subject = know?.[1]?.trim();
  if (subject === undefined || subject === '') return null;
  if (NON_NAME_CLAUSE.test(subject)) return null;
  return subject;
}

function containsGeneric(subject: string): boolean {
  return GENERIC_PHRASES.some((phrase) => subject.includes(phrase));
}

/** 泛指词去掉之后还剩不少于两个字，才算句子里夹了具体专名。 */
function hasSpecificName(subject: string): boolean {
  let rest = subject;
  for (const phrase of GENERIC_PHRASES) rest = rest.replaceAll(phrase, '');
  for (const phrase of PRONOUN_PHRASES) rest = rest.replaceAll(phrase, '');
  return charCount(coreChars(rest)) >= 2;
}

function isExcludedSubject(subject: string): boolean {
  if (PRONOUN_START.test(subject)) return true;
  if (containsGeneric(subject) && !hasSpecificName(subject)) return true;
  return false;
}

function acceptSubject(subject: string | null): string | null {
  if (subject === null || isExcludedSubject(subject)) return null;
  if (charCount(coreChars(subject)) < 2) return null;
  return subject;
}

function extractSubject(raw: string): string | null {
  const text = stripLead(raw);
  const direct = acceptSubject(matchSubject(text));
  if (direct !== null) return direct;

  // 「你知道齐主是谁吗？」→ 先剥外框 → 「齐主是谁吗？」→ 主体「齐主」。
  // 必须排在 ASK_KNOW 之前：否则「你知道 X 是谁吗」会被当成整段主体「X 是谁」。
  const unframed = stripKnowFrame(text);
  if (unframed !== text) {
    const framedWhat = acceptSubject(matchSubject(unframed));
    if (framedWhat !== null) return framedWhat;
  }
  // 「你听说过奇耻之身吗？」→ 整段主体就是专名。
  const known = acceptSubject(matchKnowSubject(text));
  if (known !== null) return known;

  if (!text.startsWith('那') || NA_DEMONSTRATIVE.test(text)) return null;
  return acceptSubject(matchSubject(trimPunct(text.slice(1))));
}

function bookTitles(reply: string): string[] {
  const titles: string[] = [];
  for (const match of reply.matchAll(/《([^》]{2,18})》/gu)) {
    const title = match[1];
    if (title !== undefined && title !== '') titles.push(title);
  }
  return titles;
}

function compactLength(text: string): number {
  return charCount(text.replace(PUNCT, ''));
}

function definitionSubject(reply: string): string {
  const titled = /《([^》]{2,18})》/u.exec(reply);
  const inner = titled?.[1];
  if (inner !== undefined && inner !== '') return `《${inner}》`;
  const isAt = reply.indexOf('是');
  const zhiAt = reply.indexOf('指');
  let cut = -1;
  if (isAt >= 0) cut = isAt;
  if (zhiAt >= 0 && (cut < 0 || zhiAt < cut)) cut = zhiAt;
  if (cut >= 0) {
    const head = trimPunct(lastChars(reply.slice(0, cut).trim(), 12));
    if (charCount(head) >= 2) return head;
  }
  return firstChars(trimPunct(reply), 12);
}

/**
 * ASR 在追问一个具体专名，Omni 却用另一个对不上的实体作答。
 * 对不上才返回；听清了、在澄清、或根本不是这种问句，都是 `null`。
 */
export function detectSubjectHallucination(
  asrText: string,
  omniReply: string,
): SubjectHallucination | null {
  const subject = extractSubject(asrText);
  if (subject === null) return null;
  const reply = omniReply.trim();
  if (compactLength(reply) < 10 || HONEST_REPLY.test(reply)) return null;
  const subjectCore = coreChars(subject);
  const total = charCount(subjectCore);
  if (total < 2) return null;

  const titles = bookTitles(reply);
  const fullCount = overlapCount(subjectCore, reply);
  const fullRate = fullCount / total;
  if (titles.length > 0) {
    const titleRate = overlapCount(subjectCore, coreChars(titles.join(''))) / total;
    const first = titles[0];
    if (first !== undefined && (fullCount === 0 || (titleRate === 0 && fullRate < MAX_INCIDENTAL_OVERLAP))) {
      return { subject, replySubject: `《${first}》` };
    }
  }
  if (DEFINITION_REPLY.test(reply) && fullCount === 0) {
    const replySubject = definitionSubject(reply);
    if (replySubject.trim() === '') return null;
    return { subject, replySubject };
  }
  return null;
}
