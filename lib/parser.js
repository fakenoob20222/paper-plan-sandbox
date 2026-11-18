/**
 * 把 OCR 文本（或手动录入文本）解析成按原始顺序排列的任务条目。
 *
 * 规则刻意保持简单、可预测：
 * 1. 一行一条任务，空行忽略；
 * 2. 去掉行首的列表符号、编号和复选框；
 * 3. 复选框里是 x / ✓ / ☑ 时，任务直接标记为已完成；
 * 4. 开头像日期或“本周计划”的短行会作为计划标题，不算任务。
 */

// 兼容 OCR 常见输出：[]、[ ]、[x]、x]、[ ，以及手写符号。
const CHECKBOX_PREFIX = /^(?:\[\s*[xX✓✔]?\s*\]|\[[xX✓✔]\s+|\[\s+|[xX]\s*\]|[☐☑✅✓✔□])\s*/u;
const BULLET_PREFIX = /^(?:[-*•·–—]\s+|\d{1,2}[.)、]\s+|\(\d{1,2}\)\s+)/u;
const CHECKBOX_SUFFIX = /\s*(?:\[\s*[xX✓✔]?\s*\]|[☐☑✅])\s*$/u;
const DONE_MARK = /[xX✓✔☑✅]/u;

const DATE_HEADER = [
  /^\d{4}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}\s*日?(?:\s*[·.、,，-]?\s*周[一二三四五六日天])?$/u,
  /^\d{1,2}\s*月\s*\d{1,2}\s*日(?:\s*[·.、,，-]?\s*周[一二三四五六日天])?$/u,
  /^周[一二三四五六日天]$/u,
];
// “本周计划”“购物清单”“今日待办”这类短标题，前缀最多 3 个汉字，
// 避免把“完成旅行计划”这样的任务误判成标题。
const TITLE_HEADER = /^[\p{Script=Han}]{0,3}(?:计划|清单|待办|日程|安排)$/u;

export function normalizeText(input) {
  return String(input ?? '')
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\u000c/gu, '\n');
}

function isHeaderLine(line) {
  return DATE_HEADER.some((pattern) => pattern.test(line)) ||
    TITLE_HEADER.test(line);
}

function normalizeHeaderLine(line) {
  return line
    .replace(/\s+/gu, ' ')
    .replace(/(\d{1,2}\s*日)\s*[·.、,，-]\s*(周[一二三四五六日天])/u, '$1 $2')
    .trim();
}

function cleanTaskLine(rawLine) {
  let line = rawLine.replace(/\s+/gu, ' ').trim();
  if (!line) return null;

  let done = false;

  const leadingCheckbox = line.match(CHECKBOX_PREFIX);
  if (leadingCheckbox) {
    done = DONE_MARK.test(leadingCheckbox[0]);
    line = line.slice(leadingCheckbox[0].length).trim();
  } else {
    const bullet = line.match(BULLET_PREFIX);
    if (bullet) {
      line = line.slice(bullet[0].length).trim();
      const checkbox = line.match(CHECKBOX_PREFIX);
      if (checkbox) {
        done = DONE_MARK.test(checkbox[0]);
        line = line.slice(checkbox[0].length).trim();
      }
    }
  }

  const trailingCheckbox = line.match(CHECKBOX_SUFFIX);
  if (trailingCheckbox && line.length > trailingCheckbox[0].length) {
    done = done || DONE_MARK.test(trailingCheckbox[0]);
    line = line.slice(0, -trailingCheckbox[0].length).trim();
  }

  if (!line) return null;
  return { text: line, done };
}

/**
 * @param {string} input
 * @returns {{title: string|null, tasks: Array<{text: string, done: boolean}>}}
 */
export function parsePlan(input) {
  const lines = normalizeText(input)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return { title: null, tasks: [] };

  const headers = [];
  let firstTask = 0;
  while (firstTask < lines.length && isHeaderLine(lines[firstTask])) {
    headers.push(normalizeHeaderLine(lines[firstTask]));
    firstTask += 1;
  }

  // 整段文字都是标题样式的行时，不吞掉内容，按普通任务处理。
  const title = firstTask < lines.length && headers.length > 0
    ? headers.join(' · ')
    : null;
  const taskLines = title ? lines.slice(firstTask) : lines;

  const tasks = [];
  for (const line of taskLines) {
    const task = cleanTaskLine(line);
    if (task) tasks.push(task);
  }

  return { title, tasks };
}

/** 只需要任务列表时的便捷函数。 */
export function parseTasks(input) {
  return parsePlan(input).tasks;
}
