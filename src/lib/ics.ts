// 读 .ics 日历文件，变成课表。教务系统、课程表 App、Outlook、Google 日历导出的都是这种文件。
//
// 能认的写法：
// - 每周重复的课（RRULE:FREQ=WEEKLY，带 INTERVAL、UNTIL、COUNT、BYDAY）和中间不上的日子（EXDATE）
// - 单独调过的某一次（带 RECURRENCE-ID 的事件）：原来那次算不上，调过去的那次单独算一节
// - 不重复、每周各写一个事件的导出方式：同一门课、同一时间的合成一节"每周上"的课，中间缺的周记成不上
// - 时间带 Z（UTC）或 TZID 时区的，换成这台电脑的本地时间
// 全天的事件和跨天的事件不是课，跳过。

import type { CourseInput } from "./planner";
import { dayKey } from "./stats";
import { isoWeekday, minuteOfDay, parseDay } from "./schedule";

export interface IcsResult {
  courses: CourseInput[];
  /** 文件里一共几个事件 */
  events: number;
  /** 跳过了几个（全天、跨天、读不懂的） */
  skipped: number;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** 折行的接回去：下一行以空格或制表符开头就是上一行的续行 */
function unfold(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += raw.slice(1);
    } else if (raw.length > 0) {
      lines.push(raw);
    }
  }
  return lines;
}

/** "DTSTART;TZID=Asia/Shanghai:20260907T080000" 拆成名字、参数、值。参数值里的冒号要在引号里 */
function parseLine(line: string): Prop | null {
  let colon = -1;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const part of head.slice(1)) {
    const eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: head[0].toUpperCase(), params, value: line.slice(colon + 1) };
}

function unescape(text: string): string {
  return text
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

/** 某个时区在某一刻比 UTC 快多少毫秒。时区名认不出来返回 null */
function zoneOffset(zone: string, utcMs: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(utcMs));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return asUtc - utcMs;
  } catch {
    return null;
  }
}

/** 一个日期时间值。`allDay` 为真是只有日期（全天事件） */
interface When {
  date: Date;
  allDay: boolean;
}

/** "20260907T080000Z"、"20260907T080000"（配 TZID）、"20260907" 变成本地时间 */
function parseWhen(prop: Prop): When | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(prop.value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s, z] = match;
  const parts = [Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0)] as const;
  if (h === undefined) return { date: new Date(parts[0], parts[1], parts[2]), allDay: true };
  if (z) return { date: new Date(Date.UTC(...parts)), allDay: false };
  const zone = prop.params.TZID;
  if (zone) {
    // 先把墙上时间当成 UTC，再减去那个时区的偏移；夏令时交界处再修正一次
    const guess = Date.UTC(...parts);
    const first = zoneOffset(zone, guess);
    if (first !== null) {
      const second = zoneOffset(zone, guess - first) ?? first;
      return { date: new Date(guess - second), allDay: false };
    }
  }
  return { date: new Date(...parts), allDay: false };
}

/** "PT1H30M" 变成分钟 */
function parseDuration(text: string): number | null {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+S)?)?$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1] ?? 0) * 1440 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

const WEEKDAYS: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

interface RawEvent {
  uid: string;
  title: string;
  place: string;
  start: Date;
  /** 分钟数 */
  startMin: number;
  endMin: number;
  rrule: Record<string, string> | null;
  exdates: string[];
  /** 这个事件是某次课单独调过的那一次：原来那次的日期 */
  recurrenceOf: string | null;
}

function addDaysTo(date: Date, n: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

/** 每周重复的事件 → 每个星期几一节课 */
function expandWeekly(ev: RawEvent): CourseInput[] {
  const rule = ev.rrule ?? {};
  const every = Math.max(1, Math.min(8, Number(rule.INTERVAL ?? 1) || 1));
  const days = (rule.BYDAY ?? "")
    .split(",")
    .map((d) => WEEKDAYS[d.trim().slice(-2).toUpperCase()])
    .filter((d): d is number => !!d);
  const weekdays = days.length > 0 ? [...new Set(days)] : [isoWeekday(ev.start)];
  const from = new Date(ev.start.getFullYear(), ev.start.getMonth(), ev.start.getDate());

  // 上到哪天：UNTIL 直接给了；COUNT 要一节一节数出来；都没有就上半年
  let until: Date;
  if (rule.UNTIL) {
    const when = parseWhen({ name: "UNTIL", params: {}, value: rule.UNTIL });
    until = when ? when.date : addDaysTo(from, 182);
  } else if (rule.COUNT) {
    let left = Math.max(1, Number(rule.COUNT) || 1);
    let cursor = from;
    let last = from;
    const mondayOfStart = addDaysTo(from, -(isoWeekday(from) - 1));
    for (let i = 0; i < 3660 && left > 0; i++) {
      cursor = addDaysTo(from, i);
      const weeks = Math.round((addDaysTo(cursor, -(isoWeekday(cursor) - 1)).getTime() - mondayOfStart.getTime()) / (7 * 86_400_000));
      if (weeks % every === 0 && weekdays.includes(isoWeekday(cursor))) {
        last = cursor;
        left -= 1;
      }
    }
    until = last;
  } else {
    until = addDaysTo(from, 182);
  }

  return weekdays.map((weekday) => ({
    title: ev.title,
    place: ev.place,
    weekday,
    start: ev.startMin,
    end: ev.endMin,
    from: dayKey(from),
    until: dayKey(until),
    every,
    skip: [...ev.exdates],
  }));
}

/**
 * 不重复的事件按"同一门课、同一时间"分组，每组合成一节每周上的课。
 * 日期之间隔的周数取最大公约数当作"每隔几周"，中间缺的那几周记成不上。
 */
function coalesce(singles: RawEvent[]): CourseInput[] {
  const groups = new Map<string, RawEvent[]>();
  for (const ev of singles) {
    const key = [ev.title, ev.place, isoWeekday(ev.start), ev.startMin, ev.endMin].join("|");
    const list = groups.get(key) ?? [];
    list.push(ev);
    groups.set(key, list);
  }
  const out: CourseInput[] = [];
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  for (const list of groups.values()) {
    const keys = [...new Set(list.map((ev) => dayKey(ev.start)))].sort();
    const first = parseDay(keys[0]);
    const weeks = keys.map((k) => Math.round((parseDay(k).getTime() - first.getTime()) / (7 * 86_400_000)));
    let every = weeks.slice(1).reduce((g, w) => gcd(g, w), 0) || 1;
    every = Math.min(8, every);
    const last = weeks[weeks.length - 1];
    const skip: string[] = [];
    for (let w = 0; w <= last; w += every) {
      const key = dayKey(addDaysTo(first, w * 7));
      if (!keys.includes(key)) skip.push(key);
    }
    const ev = list[0];
    out.push({
      title: ev.title,
      place: ev.place,
      weekday: isoWeekday(ev.start),
      start: ev.startMin,
      end: ev.endMin,
      from: keys[0],
      until: keys[keys.length - 1],
      every,
      skip,
    });
  }
  return out;
}

export function parseIcs(text: string): IcsResult {
  const lines = unfold(text);
  const raw: RawEvent[] = [];
  let events = 0;
  let skipped = 0;
  let props: Prop[] | null = null;

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      props = [];
      continue;
    }
    if (upper === "END:VEVENT") {
      events += 1;
      const ev = props ? toEvent(props) : null;
      if (ev) raw.push(ev);
      else skipped += 1;
      props = null;
      continue;
    }
    if (props) {
      const prop = parseLine(line);
      if (prop) props.push(prop);
    }
  }

  // 单独调过的某一次：原来那次记成不上
  const moved = raw.filter((ev) => ev.recurrenceOf);
  const base = raw.filter((ev) => !ev.recurrenceOf);
  for (const m of moved) {
    const series = base.find((ev) => ev.uid === m.uid && ev.rrule);
    if (series && m.recurrenceOf) series.exdates.push(m.recurrenceOf);
  }

  const weekly = base.filter((ev) => ev.rrule && (ev.rrule.FREQ ?? "").toUpperCase() === "WEEKLY");
  const singles = [...base.filter((ev) => !weekly.includes(ev)), ...moved];
  const courses = [...weekly.flatMap(expandWeekly), ...coalesce(singles)];
  return { courses, events, skipped };
}

function toEvent(props: Prop[]): RawEvent | null {
  const get = (name: string) => props.find((p) => p.name === name);
  const startProp = get("DTSTART");
  if (!startProp) return null;
  const start = parseWhen(startProp);
  if (!start || start.allDay) return null;

  let end: Date | null = null;
  const endProp = get("DTEND");
  if (endProp) end = parseWhen(endProp)?.date ?? null;
  if (!end) {
    const duration = get("DURATION");
    const minutes = duration ? parseDuration(duration.value) : null;
    if (minutes !== null) end = new Date(start.date.getTime() + minutes * 60_000);
  }
  if (!end || end <= start.date) return null;
  // 跨天的不是课
  if (dayKey(end) !== dayKey(start.date) && !(minuteOfDay(end) === 0 && end.getTime() - start.date.getTime() <= 86_400_000)) {
    return null;
  }
  const startMin = minuteOfDay(start.date);
  const endMin = dayKey(end) === dayKey(start.date) ? minuteOfDay(end) : 24 * 60;
  if (endMin <= startMin) return null;

  const title = unescape(get("SUMMARY")?.value ?? "");
  if (!title) return null;

  let rrule: Record<string, string> | null = null;
  const ruleProp = get("RRULE");
  if (ruleProp) {
    rrule = {};
    for (const part of ruleProp.value.split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0) rrule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
    }
  }

  const exdates: string[] = [];
  for (const p of props.filter((x) => x.name === "EXDATE")) {
    for (const value of p.value.split(",")) {
      const when = parseWhen({ ...p, value });
      if (when) exdates.push(dayKey(when.date));
    }
  }

  const recurrence = get("RECURRENCE-ID");
  const recurrenceWhen = recurrence ? parseWhen(recurrence) : null;

  return {
    uid: get("UID")?.value ?? "",
    title: title.slice(0, 60),
    place: unescape(get("LOCATION")?.value ?? "").slice(0, 40),
    start: start.date,
    startMin,
    endMin,
    rrule,
    exdates,
    recurrenceOf: recurrenceWhen ? dayKey(recurrenceWhen.date) : null,
  };
}
