// 把学校给的课表（PDF、网页、从网页上复制的表格）变成课。
//
// 三种来源先变成同一种东西：按文档顺序排的"一段文字"和"一张表"（TtBlock），再统一认。
// 认得两种排法：
// - 一行一节课：表头有"开始/结束"（或"时间"）、"课程/Module"、"周次/Weeks"、"地点/Room"这些列；
//   星期几要么是一列，要么写在表格上面（Monday、星期一）
// - 课程表格子：表头是星期一到星期日，每格里写课名、周次、教室，行头写几点到几点
//
// 周次（1-11、2-7、1,10-11、1-16周(单)）要知道第 1 周是哪天才能换成日期：
// 文件里写了（"Weeks: 1-11 (21 Sep 2026 - 6 Dec 2026)"、"第1周 2026-09-07"）就用，没写让用户选。

import { coursesFromDates } from "./ics";
import type { PdfDoc, PdfTag, PdfText } from "./pdf";
import type { CourseInput } from "./planner";
import { dayKey } from "./stats";

export type TtBlock = { kind: "text"; text: string } | { kind: "table"; rows: string[][] };

export interface TimetableResult {
  courses: CourseInput[];
  /** 换成日期以后一共多少次课 */
  events: number;
  /** 认出来的课（表格里的行或者格子）有几条 */
  rows: number;
  /** 像是课但读不懂的（没有时间、没有星期几） */
  skipped: number;
  /** 第 1 周的周一。null：用不上（没有周次） */
  weekOne: string | null;
  /** 第 1 周是从文件里读到的；假的话是猜的，要让用户确认 */
  weekOneFound: boolean;
}

// ---------- 小工具 ----------

/** 全角数字、标点换成半角，各种横线换成 "-" */
function ascii(text: string): string {
  return text
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ")
    .replace(/[–—−~～至到]/g, "-");
}

/** 多行合成一行。行尾是连字符的（"Drop-" 换行 "In"）直接接上，不加空格 */
function clean(text: string): string {
  return text.replace(/-[ \t]*\n\s*/g, "-").replace(/\s+/g, " ").trim();
}

function mondayOf(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** "21 Sep 2026"、"Sep 21, 2026"、"2026-09-21"、"2026年9月21日" */
function parseDate(text: string): Date | null {
  const t = ascii(text);
  let m = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(t);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /(\d{1,2})\s+([a-z]{3,9})\.?,?\s+(\d{4})/i.exec(t);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
    return new Date(Number(m[3]), MONTHS[m[2].slice(0, 3).toLowerCase()] - 1, Number(m[1]));
  }
  m = /([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(t);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) {
    return new Date(Number(m[3]), MONTHS[m[1].slice(0, 3).toLowerCase()] - 1, Number(m[2]));
  }
  return null;
}

/** 文件里写的"第几周是哪天"。返回那一周的周一和周数 */
export function findWeekOne(text: string): { monday: Date; week: number } | null {
  const t = clean(ascii(text));
  const patterns: RegExp[] = [
    // Weeks: 1-11 (21 Sep 2026 - 6 Dec 2026)
    /weeks?\s*:?\s*(\d+)\s*-\s*\d+\s*\(\s*([^)]+?)\s*-/i,
    // 第1周 (2026-09-07) / 第 1 周：2026年9月7日
    /第\s*(\d+)\s*周[^\d]{0,8}(\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2})/,
    // Week 1: 7 Sep 2026 / Week 1 starts 2026-09-07
    /week\s*(\d+)\b[^\d]{0,16}(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\s+[a-z]{3,9}\.?\s+\d{4}|[a-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/i,
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    if (!m) continue;
    const date = parseDate(m[2]);
    if (date) return { monday: mondayOf(date), week: Number(m[1]) || 1 };
  }
  // 开学：2026-09-07
  const m = /(开学|学期开始|第一周|term starts?|semester starts?)[^\d]{0,10}(\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2})/i.exec(t);
  if (m) {
    const date = parseDate(m[2]);
    if (date) return { monday: mondayOf(date), week: 1 };
  }
  return null;
}

/** 课表上写的学期周数范围（"Weeks: 1-11"、"1-18周"），没有周次列时按这个算 */
function findTermWeeks(text: string): [number, number] | null {
  const t = ascii(text);
  const m = /weeks?\s*:?\s*(\d+)\s*-\s*(\d+)/i.exec(t) ?? /第?\s*(\d+)\s*-\s*(\d+)\s*周/.exec(t);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a >= 1 && b >= a && b <= 60 ? [a, b] : null;
}

/** "1, 10-11"、"2-7"、"1-16周(单)"、"3,5,7周" → 周数列表。读不懂返回 null */
export function parseWeeks(text: string): number[] | null {
  let t = ascii(text).toLowerCase();
  t = t.replace(/[()[\]（）【】]/g, " ").replace(/第|weeks?|wks?|周|週/g, " ");
  t = t.replace(/\s*-\s*/g, "-");
  const parts = t.split(/[,;、\s]+/).filter(Boolean);
  const out = new Set<number>();
  let last: number[] = [];
  for (const part of parts) {
    if (/^(单|odd)$/.test(part) || /^(双|even)$/.test(part)) {
      // 跟在前一段后面的"单""双"
      const odd = /^(单|odd)$/.test(part);
      for (const w of last) if (w % 2 !== (odd ? 1 : 0)) out.delete(w);
      continue;
    }
    const m = /^(\d+)(?:-(\d+))?(单|双|odd|even)?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a || b > 60) continue;
    last = [];
    for (let w = a; w <= b; w++) {
      if (m[3] === "单" || m[3] === "odd") {
        if (w % 2 === 0) continue;
      } else if (m[3] === "双" || m[3] === "even") {
        if (w % 2 === 1) continue;
      }
      out.add(w);
      last.push(w);
    }
  }
  return out.size > 0 ? [...out].sort((x, y) => x - y) : null;
}

/** "9:00"、"09.00"、"1:30 PM"、"13点30" → 分钟数 */
function parseClock(text: string): number | null {
  const t = ascii(text).trim().toLowerCase();
  const m = /^(\d{1,2})\s*[:.：点時时]\s*(\d{2})?\s*(分)?\s*(am|pm|上午|下午)?/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[4];
  if ((ap === "pm" || ap === "下午") && h < 12) h += 12;
  if ((ap === "am" || ap === "上午") && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** "09:00-10:40" → [540, 640] */
function parseRange(text: string): [number, number] | null {
  const t = ascii(text);
  const m = /(\d{1,2}\s*[:.：]\s*\d{2}\s*(?:am|pm)?)\s*-\s*(\d{1,2}\s*[:.：]\s*\d{2}\s*(?:am|pm)?)/i.exec(t);
  if (!m) return null;
  const a = parseClock(m[1]);
  const b = parseClock(m[2]);
  return a !== null && b !== null && b > a ? [a, b] : null;
}

const WEEKDAY_WORDS: [RegExp, number][] = [
  [/^(monday|mon|星期一|周一|週一|礼拜一|禮拜一|一)$/, 1],
  [/^(tuesday|tue|tues|星期二|周二|週二|礼拜二|禮拜二|二)$/, 2],
  [/^(wednesday|wed|星期三|周三|週三|礼拜三|禮拜三|三)$/, 3],
  [/^(thursday|thu|thur|thurs|星期四|周四|週四|礼拜四|禮拜四|四)$/, 4],
  [/^(friday|fri|星期五|周五|週五|礼拜五|禮拜五|五)$/, 5],
  [/^(saturday|sat|星期六|周六|週六|礼拜六|禮拜六|六)$/, 6],
  [/^(sunday|sun|星期日|星期天|周日|週日|周天|礼拜日|礼拜天|禮拜日|日|天)$/, 7],
];

/** 一整段就是星期几（"Monday"、"星期一"）才算。digits：允许 1-7 这种写法（星期列里用） */
function weekdayOf(text: string, digits = false): number | null {
  const t = clean(ascii(text)).toLowerCase().replace(/[.:：]$/, "");
  if (!t) return null;
  if (digits && /^[1-7]$/.test(t)) return Number(t);
  for (const [re, day] of WEEKDAY_WORDS) if (re.test(t)) return day;
  return null;
}

// ---------- 表头 ----------

type Role = "title" | "activity" | "type" | "day" | "start" | "end" | "time" | "weeks" | "place" | "other";

const ROLE_WORDS: [Role, string[]][] = [
  ["start", ["start", "start time", "begin", "from", "开始", "开始时间", "起始时间", "上课开始"]],
  ["end", ["end", "end time", "finish", "until", "to", "结束", "结束时间", "下课时间"]],
  ["weeks", ["weeks", "week", "week(s)", "wks", "周次", "上课周次", "教学周", "起止周", "周数"]],
  ["day", ["day", "weekday", "day of week", "星期", "周几", "上课星期", "星期几"]],
  ["place", ["room", "location", "venue", "place", "地点", "教室", "上课地点", "上课教室", "场地"]],
  ["type", ["type", "activity type", "class type", "类型", "课程类型", "授课方式", "上课类型"]],
  ["title", ["module", "course", "subject", "course name", "module title", "class", "课程", "课程名称", "课程名", "科目", "课名"]],
  ["activity", ["activity", "活动", "教学班", "description"]],
  ["time", ["time", "times", "时间", "上课时间", "节次时间"]],
  ["other", ["duration", "staff", "lecturer", "teacher", "instructor", "时长", "教师", "老师", "任课教师", "学分", "credits"]],
];

function roleOf(cell: string): Role | null {
  const t = clean(ascii(cell)).toLowerCase().replace(/[:：]$/, "");
  if (!t || t.length > 30) return null;
  for (const [role, words] of ROLE_WORDS) if (words.includes(t)) return role;
  for (const [role, words] of ROLE_WORDS) {
    if (words.some((w) => w.length >= 3 && (t.startsWith(w + " ") || t.endsWith(" " + w) || (/[一-鿿]/.test(w) && t.includes(w))))) {
      return role;
    }
  }
  return null;
}

type Columns = Partial<Record<Exclude<Role, "other">, number>>;

/** 认表头：返回每种列在第几格。没有时间、没有课名就不算课表的表头 */
function readHeader(row: string[]): Columns | null {
  const cols: Columns = {};
  let hits = 0;
  row.forEach((cell, i) => {
    const role = roleOf(cell);
    if (!role) return;
    hits++;
    if (role !== "other" && cols[role] === undefined) cols[role] = i;
  });
  const hasTime = (cols.start !== undefined && cols.end !== undefined) || cols.time !== undefined;
  const hasTitle = cols.title !== undefined || cols.activity !== undefined;
  return hits >= 3 && hasTime && hasTitle ? cols : null;
}

/** 课程表格子的表头：至少五格是星期几。返回 星期几 → 第几格 */
function readGridHeader(row: string[]): Map<number, number> | null {
  const days = new Map<number, number>();
  row.forEach((cell, i) => {
    const day = weekdayOf(cell);
    if (day && !days.has(day)) days.set(day, i);
  });
  return days.size >= 5 ? days : null;
}

// ---------- 认课 ----------

interface Found {
  title: string;
  place: string;
  weekday: number;
  start: number;
  end: number;
  /** null：没写周次，整个学期每周都上 */
  weeks: number[] | null;
}

/** 课名、地点里的杂项去掉：教室容量"[cap.160]"、多余空白 */
function tidyPlace(text: string): string {
  return clean(text.replace(/\[\s*cap\.?\s*\d+\s*\]/gi, "").replace(/\(\s*容量[^)]*\)/g, ""));
}

/** 一行一节课的表格 */
function rowsTable(rows: string[][], cols: Columns, day: number | null): { found: Found[]; skipped: number } {
  const found: Found[] = [];
  let skipped = 0;
  const cell = (row: string[], i: number | undefined) => (i === undefined ? "" : (row[i] ?? ""));
  for (const row of rows) {
    if (row.every((c) => !c.trim())) continue;
    let range: [number, number] | null = null;
    if (cols.start !== undefined && cols.end !== undefined) {
      const a = parseClock(cell(row, cols.start));
      const b = parseClock(cell(row, cols.end));
      if (a !== null && b !== null && b > a) range = [a, b];
    }
    if (!range && cols.time !== undefined) range = parseRange(cell(row, cols.time));
    const weekday = cols.day !== undefined ? weekdayOf(cell(row, cols.day), true) ?? leadingWeekday(cell(row, cols.day)) : day;
    if (!range || !weekday) {
      // 只是一行字（备注、分组标题）的不算读不懂
      if (row.some((c) => parseRange(c) || parseClock(c) !== null)) skipped++;
      continue;
    }
    const main = clean(cell(row, cols.title)) || clean(cell(row, cols.activity));
    const type = clean(cell(row, cols.type));
    const title = (type && main && !main.toLowerCase().includes(type.toLowerCase()) ? `${main} (${type})` : main) || type;
    if (!title) {
      skipped++;
      continue;
    }
    const weeksText = cell(row, cols.weeks);
    found.push({
      title: title.slice(0, 80),
      place: tidyPlace(cell(row, cols.place)).slice(0, 80),
      weekday,
      start: range[0],
      end: range[1],
      weeks: cols.weeks !== undefined && weeksText.trim() ? parseWeeks(weeksText) : null,
    });
  }
  return { found, skipped };
}

/** "Mon 9:00" 这种开头带星期几的 */
function leadingWeekday(text: string): number | null {
  const first = clean(ascii(text)).split(/[\s,，]/)[0] ?? "";
  return weekdayOf(first);
}

/** 课程表格子：每格可能有好几门课，用空行或横线隔开 */
function gridTable(rows: string[][], days: Map<number, number>): { found: Found[]; skipped: number } {
  const found: Found[] = [];
  let skipped = 0;
  const firstDayCol = Math.min(...days.values());
  for (const row of rows) {
    const head = row.slice(0, firstDayCol).join(" ");
    const rowRange = parseRange(head);
    for (const [weekday, col] of days) {
      const text = (row[col] ?? "").trim();
      if (!text) continue;
      const chunks = text.split(/\n\s*\n|\n?-{3,}\n?|\n?={3,}\n?/).map((c) => c.trim()).filter(Boolean);
      for (const chunk of chunks) {
        const lines = chunk.split(/\n|\s{2,}|◇|◆|\|/).map(clean).filter(Boolean);
        if (lines.length === 0) continue;
        const range = parseRange(chunk) ?? rowRange;
        if (!range) {
          skipped++;
          continue;
        }
        let weeks: number[] | null = null;
        let place = "";
        const rest: string[] = [];
        for (const line of lines.slice(1)) {
          const w = /([\d,，、\-–\s]+)\s*(?:\((?:单|双)\))?\s*周|week[s]?\s*[\d,\-\s]+/i.exec(ascii(line));
          if (!weeks && w) {
            weeks = parseWeeks(w[0] + (/单/.test(line) ? " 单" : /双/.test(line) ? " 双" : ""));
            continue;
          }
          if (!place && (/教室|教学楼|楼|室|馆|room|lt\b|hall|lab|@/i.test(line) || /[a-z]?\d{3,}/i.test(line)) && !parseRange(line)) {
            place = line.replace(/^@/, "");
            continue;
          }
          rest.push(line);
        }
        found.push({
          title: lines[0].slice(0, 80),
          place: tidyPlace(place).slice(0, 80),
          weekday,
          start: range[0],
          end: range[1],
          weeks,
        });
        void rest;
      }
    }
  }
  return { found: mergeAdjacent(found), skipped };
}

/** 跨了好几节的课（格子跨行）会被拆成一节一节的：同一门课首尾相接（隔不到半小时）的接成一节 */
function mergeAdjacent(list: Found[]): Found[] {
  const sorted = [...list].sort((a, b) => a.weekday - b.weekday || a.title.localeCompare(b.title) || a.start - b.start);
  const out: Found[] = [];
  for (const f of sorted) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.weekday === f.weekday &&
      prev.title === f.title &&
      prev.place === f.place &&
      String(prev.weeks) === String(f.weeks) &&
      f.start >= prev.start &&
      f.start - prev.end <= 30
    ) {
      prev.end = Math.max(prev.end, f.end);
    } else {
      out.push({ ...f });
    }
  }
  return out;
}

/**
 * 认课：返回课和统计。weekOneOverride 是用户选的"第 1 周的周一"（"2026-09-21"），
 * 不给就用文件里写的，文件里也没有就用下一个周一
 */
export function readTimetable(blocks: TtBlock[], weekOneOverride: string | null = null): TimetableResult {
  const allText = blocks
    .map((b) => (b.kind === "text" ? b.text : b.rows.slice(0, 2).map((r) => r.join(" ")).join(" ")))
    .join(" ");
  const fileWeek = findWeekOne(allText);
  const term = findTermWeeks(allText);

  const found: Found[] = [];
  let skipped = 0;
  let day: number | null = null;
  let lastCols: { cols: Columns; width: number } | null = null;

  for (const block of blocks) {
    if (block.kind === "text") {
      const d = weekdayOf(block.text);
      if (d) day = d;
      continue;
    }
    const rows = block.rows;
    let headerAt = -1;
    let cols: Columns | null = null;
    for (let i = 0; i < Math.min(rows.length, 4); i++) {
      cols = readHeader(rows[i]);
      if (cols) {
        headerAt = i;
        break;
      }
    }
    if (cols) {
      lastCols = { cols, width: rows[headerAt].length };
      const got = rowsTable(rows.slice(headerAt + 1), cols, day);
      found.push(...got.found);
      skipped += got.skipped;
      continue;
    }
    let grid: Map<number, number> | null = null;
    for (let i = 0; i < Math.min(rows.length, 3); i++) {
      grid = readGridHeader(rows[i]);
      if (grid) {
        headerAt = i;
        break;
      }
    }
    if (grid) {
      const got = gridTable(rows.slice(headerAt + 1), grid);
      found.push(...got.found);
      skipped += got.skipped;
      continue;
    }
    // 没有表头：多半是上一页的表接着往下（PDF 翻页），列数一样就接着用上一张的表头
    if (lastCols && rows.length > 0 && rows.every((r) => Math.abs(r.length - lastCols!.width) <= 0)) {
      const got = rowsTable(rows, lastCols.cols, day);
      found.push(...got.found);
      skipped += got.skipped;
    }
  }

  const usesWeeks = found.some((f) => f.weeks !== null) || !!term;
  let monday: Date;
  let weekNo = 1;
  let weekOneFound = false;
  if (weekOneOverride) {
    const [y, m, d] = weekOneOverride.split("-").map(Number);
    monday = mondayOf(new Date(y, (m || 1) - 1, d || 1));
  } else if (fileWeek) {
    monday = fileWeek.monday;
    weekNo = fileWeek.week;
    weekOneFound = true;
  } else {
    const now = new Date();
    monday = mondayOf(now);
    if (now.getDay() !== 1) monday.setDate(monday.getDate() + 7);
  }

  // 没写周次的课：有学期范围按范围，没有按 16 周
  const defaultWeeks = term ? range(term[0], term[1]) : range(weekNo, weekNo + 15);
  const dated: { title: string; place: string; start: Date; startMin: number; endMin: number }[] = [];
  const seen = new Set<string>();
  for (const f of found) {
    for (const w of f.weeks ?? defaultWeeks) {
      const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + (w - weekNo) * 7 + (f.weekday - 1));
      const key = [f.title, f.place, dayKey(date), f.start, f.end].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      dated.push({ title: f.title, place: f.place, start: date, startMin: f.start, endMin: f.end });
    }
  }

  return {
    courses: coursesFromDates(dated),
    events: dated.length,
    rows: found.length,
    skipped,
    weekOne: usesWeeks || found.length > 0 ? dayKey(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - (weekNo - 1) * 7)) : null,
    weekOneFound,
  };
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let w = a; w <= b; w++) out.push(w);
  return out;
}

// ---------- 网页 ----------

const BLOCK_TAGS = new Set(["P", "DIV", "LI", "TR", "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "ARTICLE", "UL", "OL"]);

/** 格子里的字：<br> 和块级元素换行，别的连在一起 */
function cellText(node: Node): string {
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      out += (n.nodeValue ?? "").replace(/\s+/g, " ");
      return;
    }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    const tag = el.tagName.toUpperCase();
    if (tag === "SCRIPT" || tag === "STYLE") return;
    if (tag === "BR") {
      out += "\n";
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) out += "\n";
    el.childNodes.forEach(walk);
    if (block) out += "\n";
  };
  walk(node);
  return out
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 一张 HTML 表格 → 一格一格的行。跨行、跨列的格子展开，位置才对得上 */
function tableRows(table: Element): string[][] {
  const rows: string[][] = [];
  const pending: (string | undefined)[][] = [];
  const trs = [...table.querySelectorAll("tr")].filter((tr) => tr.closest("table") === table);
  trs.forEach((tr, r) => {
    const row: string[] = [];
    const carry = pending[r] ?? [];
    let col = 0;
    const cells = [...tr.children].filter((c) => /^(TD|TH)$/i.test(c.tagName));
    const place = (text: string) => {
      while (carry[col] !== undefined) {
        row[col] = carry[col] as string;
        col++;
      }
      row[col] = text;
    };
    for (const c of cells) {
      const text = cellText(c);
      const colspan = Math.max(1, Math.min(20, Number(c.getAttribute("colspan")) || 1));
      const rowspan = Math.max(1, Math.min(30, Number(c.getAttribute("rowspan")) || 1));
      for (let k = 0; k < colspan; k++) {
        place(k === 0 ? text : "");
        for (let d = 1; d < rowspan; d++) {
          pending[r + d] ??= [];
          pending[r + d][col] = k === 0 ? text : "";
        }
        col++;
      }
    }
    while (carry[col] !== undefined) {
      row[col] = carry[col] as string;
      col++;
    }
    rows.push(Array.from(row, (c) => c ?? ""));
  });
  return rows;
}

/** 网页（另存的 .html，或者从网页复制下来的表格）→ 文字和表格 */
export function blocksFromHtml(html: string): TtBlock[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks: TtBlock[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      const text = clean(node.nodeValue ?? "");
      if (text) blocks.push({ kind: "text", text });
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return;
    if (tag === "TABLE") blocks.push({ kind: "table", rows: tableRows(el) });
    el.childNodes.forEach(walk);
  };
  walk(doc.body ?? doc.documentElement);
  return blocks;
}

/** 复制下来的纯文字：Excel、网页表格复制出来是制表符隔开的；没有制表符就按两个以上空格分 */
export function blocksFromText(text: string): TtBlock[] {
  const blocks: TtBlock[] = [];
  let table: string[][] | null = null;
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.replace(/\s+$/, "");
    let cells: string[] | null = null;
    if (line.includes("\t")) cells = line.split("\t").map((c) => c.trim());
    else {
      const parts = line.trim().split(/\s{2,}/);
      if (parts.length >= 3) cells = parts;
    }
    if (cells) {
      table ??= [];
      table.push(cells);
      continue;
    }
    if (table) {
      blocks.push({ kind: "table", rows: table });
      table = null;
    }
    if (line.trim()) blocks.push({ kind: "text", text: clean(line) });
  }
  if (table) blocks.push({ kind: "table", rows: table });
  // 一行一行贴进来的表，各行列数可能不一样（空格子被吃掉了）。表头那一行最全，按它补齐
  return blocks;
}

// ---------- PDF ----------

/** 一堆文字按位置拼成一行一行：从上到下，同一行从左到右 */
function linesOf(items: PdfText[]): PdfText[][] {
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const lines: PdfText[][] = [];
  for (const it of sorted) {
    const line = lines[lines.length - 1];
    if (line && line[0].page === it.page && Math.abs(line[0].y - it.y) < Math.max(it.size, line[0].size) * 0.5) {
      line.push(it);
    } else {
      lines.push([it]);
    }
  }
  for (const line of lines) line.sort((a, b) => a.x - b.x);
  return lines;
}

function joinLine(line: PdfText[]): string {
  let out = "";
  let prev: PdfText | null = null;
  for (const it of line) {
    if (prev && it.x - prev.x1 > Math.max(it.size, 1) * 0.15 && !out.endsWith(" ")) out += " ";
    out += it.str;
    prev = it;
  }
  return out.trim();
}

function textOfItems(items: PdfText[]): string {
  return linesOf(items).map(joinLine).filter(Boolean).join("\n");
}

/** 带标签的 PDF：按标签树里的表格、行、格子取字 */
function blocksFromTags(doc: PdfDoc, root: PdfTag): TtBlock[] {
  const byMcid = new Map<string, PdfText[]>();
  doc.pages.forEach((items) => {
    for (const it of items) {
      if (it.mcid === null) continue;
      const key = `${it.page}:${it.mcid}`;
      const list = byMcid.get(key) ?? [];
      list.push(it);
      byMcid.set(key, list);
    }
  });
  const itemsUnder = (tag: PdfTag, out: PdfText[] = []): PdfText[] => {
    for (const kid of tag.kids) {
      if ("mcid" in kid) out.push(...(byMcid.get(`${kid.page}:${kid.mcid}`) ?? []));
      else itemsUnder(kid, out);
    }
    return out;
  };
  /** 表格里的行：中间可能隔着 THead、TBody 之类的，但不进到套在格子里的另一张表 */
  const rowsOf = (tag: PdfTag, out: PdfTag[] = []): PdfTag[] => {
    for (const kid of tag.kids) {
      if ("mcid" in kid) continue;
      if (kid.type === "TR") out.push(kid);
      else if (kid.type !== "Table") rowsOf(kid, out);
    }
    return out;
  };
  const cellsOf = (tr: PdfTag): PdfTag[] =>
    tr.kids.filter((k): k is PdfTag => !("mcid" in k) && (k.type === "TD" || k.type === "TH"));

  const blocks: TtBlock[] = [];
  let count = 0;
  const walk = (tag: PdfTag) => {
    if (++count > 100_000) return;
    if (tag.type === "Table") {
      const rows = rowsOf(tag).map((tr) => cellsOf(tr).map((td) => textOfItems(itemsUnder(td))));
      if (rows.length > 0) blocks.push({ kind: "table", rows });
    }
    const direct: PdfText[] = [];
    for (const kid of tag.kids) {
      if ("mcid" in kid) direct.push(...(byMcid.get(`${kid.page}:${kid.mcid}`) ?? []));
    }
    if (direct.length > 0) {
      const text = clean(textOfItems(direct));
      if (text) blocks.push({ kind: "text", text });
    }
    for (const kid of tag.kids) if (!("mcid" in kid)) walk(kid);
  };
  walk(root);
  return blocks;
}

/**
 * 不带标签的 PDF：按位置猜表格。
 * 找到表头那一行以后，下面的字按"哪几段横向位置上有字"切成列；
 * 每节课以"开始时间那一格有时间"的那一行为准，上下挨着的字归到离得最近的那节课
 */
function blocksFromPositions(doc: PdfDoc): TtBlock[] {
  const blocks: TtBlock[] = [];
  const lines = linesOf(doc.pages.flat());
  let i = 0;
  let carry: { header: PdfText[] } | null = null;
  while (i < lines.length) {
    const line = lines[i];
    const isHeader = readHeader(line.map((it) => it.str)) !== null;
    const continuing = carry && !isHeader && i > 0 && lines[i - 1][0].page !== line[0].page;
    if (!isHeader && !continuing) {
      blocks.push({ kind: "text", text: joinLine(line) });
      i++;
      continue;
    }
    const header: PdfText[] = isHeader ? line : carry!.header;
    if (isHeader) i++;
    const body: PdfText[][] = [];
    while (i < lines.length) {
      const l = lines[i];
      const text = joinLine(l);
      if (readHeader(l.map((it) => it.str)) || (weekdayOf(text) && l.length === 1)) break;
      if (body.length > 0 && l[0].page !== body[body.length - 1][0].page) break;
      body.push(l);
      i++;
    }
    carry = { header };
    blocks.push({ kind: "table", rows: positionalRows(header, body) });
  }
  return blocks;
}

function positionalRows(header: PdfText[], body: PdfText[][]): string[][] {
  // 横向上哪几段有字：所有字的 [x, x1] 并起来，中间空出来的缝就是列和列的分界
  const spans = [...header, ...body.flat()].map((it) => [it.x, it.x1] as [number, number]).sort((a, b) => a[0] - b[0]);
  const clusters: [number, number][] = [];
  for (const [a, b] of spans) {
    const last = clusters[clusters.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else clusters.push([a, b]);
  }
  // 每列认一个表头；没有表头的那段并到左边那列
  const labelOf = (c: [number, number]) => header.filter((h) => (h.x + h.x1) / 2 >= c[0] - 1 && (h.x + h.x1) / 2 <= c[1] + 1);
  const cols: { x0: number; x1: number; label: string }[] = [];
  for (const c of clusters) {
    const labels = labelOf(c);
    if (labels.length === 0 && cols.length > 0) cols[cols.length - 1].x1 = c[1];
    else cols.push({ x0: c[0], x1: c[1], label: labels.map((h) => h.str).join(" ") });
  }
  const colOf = (it: PdfText) => {
    const mid = (it.x + it.x1) / 2;
    let best = 0;
    let dist = Infinity;
    cols.forEach((c, k) => {
      const d = mid < c.x0 ? c.x0 - mid : mid > c.x1 ? mid - c.x1 : 0;
      if (d < dist) {
        dist = d;
        best = k;
      }
    });
    return best;
  };
  const head = cols.map((c) => c.label);
  const roles = readHeader(head);
  const timeCol = roles?.start ?? roles?.time;
  // 每节课的"锚"：时间那一格里有时间的行
  const anchors = body.filter((l) =>
    l.some((it) => colOf(it) === timeCol && (parseClock(it.str) !== null || parseRange(it.str) !== null)),
  );
  if (anchors.length === 0) return [head];
  const cells: PdfText[][][] = anchors.map(() => cols.map(() => []));
  for (const l of body) {
    const y = l[0].y;
    let best = 0;
    anchors.forEach((a, k) => {
      if (Math.abs(a[0].y - y) < Math.abs(anchors[best][0].y - y)) best = k;
    });
    for (const it of l) cells[best][colOf(it)].push(it);
  }
  return [head, ...cells.map((row) => row.map((items) => textOfItems(items)))];
}

/** 读出来的 PDF → 文字和表格。带标签而且标签里有表格的按标签，不然按位置 */
export function blocksFromPdf(doc: PdfDoc): TtBlock[] {
  if (doc.tags) {
    const tagged = blocksFromTags(doc, doc.tags);
    if (tagged.some((b) => b.kind === "table" && b.rows.some((r) => readHeader(r) || readGridHeader(r)))) {
      return tagged;
    }
  }
  return blocksFromPositions(doc);
}
