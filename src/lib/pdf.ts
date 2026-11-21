// 读 PDF 里的文字，给导入课表用。不靠第三方库：只认课表 PDF 常见的那几种写法。
//
// 认得的：
// - 未加密的 PDF，对象直接写在文件里或者压在对象流（ObjStm）里
// - FlateDecode 压缩（浏览器自带的 DecompressionStream 解）
// - 字体带 ToUnicode 对照表的（浏览器"打印成 PDF"、Word 导出的都带），没有的按单字节拉丁字母猜
// - 带标签的 PDF（Chrome、Edge 打印网页时默认带）：直接按标签里的表格、行、格子取文字，最准
// - 不带标签的：按文字在纸上的位置拼成一行一行，交给 timetable.ts 去猜表格
//
// 扫描出来的图片 PDF 没有文字，读不出来。

/** 纸上的一段文字：从 x 到 x1，基线在 y（PDF 坐标，越往上 y 越大） */
export interface PdfText {
  str: string;
  x: number;
  x1: number;
  y: number;
  size: number;
  page: number;
  /** 这段文字属于哪个带标签的内容（MCID），没有标签就是 null */
  mcid: number | null;
}

/** 标签树里的一个节点：类型（Table、TR、TD、P……）和它下面的东西 */
export interface PdfTag {
  type: string;
  kids: (PdfTag | { page: number; mcid: number })[];
}

export interface PdfDoc {
  pages: PdfText[][];
  /** 没有标签就是 null */
  tags: PdfTag | null;
}

// ---------- 对象 ----------

type PdfValue = number | boolean | null | string | PdfName | PdfRef | PdfValue[] | PdfDict | PdfStream;

class PdfName {
  constructor(readonly name: string) {}
}

class PdfRef {
  constructor(
    readonly num: number,
    readonly gen: number,
  ) {}
}

type PdfDict = Map<string, PdfValue>;

class PdfStream {
  constructor(
    readonly dict: PdfDict,
    readonly raw: Uint8Array,
  ) {}
}

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set("()<>[]{}/%".split("").map((c) => c.charCodeAt(0)));

/** 从 latin1 字符串里一个一个读 PDF 的值 */
class Lexer {
  pos: number;
  constructor(
    readonly s: string,
    pos = 0,
  ) {
    this.pos = pos;
  }

  skip(): void {
    const s = this.s;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (WS.has(c)) this.pos++;
      else if (c === 37) {
        // % 注释到行尾
        while (this.pos < s.length && s[this.pos] !== "\n" && s[this.pos] !== "\r") this.pos++;
      } else break;
    }
  }

  /** 普通字符连成的一个词：数字、关键字、操作符 */
  word(): string {
    const s = this.s;
    const start = this.pos;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (WS.has(c) || DELIM.has(c)) break;
      this.pos++;
    }
    return s.slice(start, this.pos);
  }

  name(): string {
    this.pos++; // "/"
    const raw = this.word();
    return raw.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  }

  /** (……) 里的字符串，处理转义和嵌套括号。返回 latin1 字符串（一个字符一个字节） */
  literal(): string {
    const s = this.s;
    this.pos++;
    let depth = 1;
    let out = "";
    while (this.pos < s.length) {
      const ch = s[this.pos++];
      if (ch === "\\") {
        const n = s[this.pos++];
        if (n === "n") out += "\n";
        else if (n === "r") out += "\r";
        else if (n === "t") out += "\t";
        else if (n === "b") out += "\b";
        else if (n === "f") out += "\f";
        else if (n === "\r") {
          if (s[this.pos] === "\n") this.pos++;
        } else if (n === "\n") {
          // 续行
        } else if (n >= "0" && n <= "7") {
          let oct = n;
          while (oct.length < 3 && s[this.pos] >= "0" && s[this.pos] <= "7") oct += s[this.pos++];
          out += String.fromCharCode(parseInt(oct, 8) & 255);
        } else out += n;
      } else if (ch === "(") {
        depth++;
        out += ch;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) break;
        out += ch;
      } else out += ch;
    }
    return out;
  }

  /** <……> 十六进制字符串 */
  hex(): string {
    const end = this.s.indexOf(">", this.pos);
    let digits = this.s.slice(this.pos + 1, end < 0 ? this.s.length : end).replace(/[^0-9a-fA-F]/g, "");
    this.pos = end < 0 ? this.s.length : end + 1;
    if (digits.length % 2) digits += "0";
    let out = "";
    for (let i = 0; i < digits.length; i += 2) out += String.fromCharCode(parseInt(digits.slice(i, i + 2), 16));
    return out;
  }

  /** 读一个值。读到 ] 或 >> 返回 undefined（给数组、字典收尾用） */
  value(): PdfValue | undefined {
    this.skip();
    const s = this.s;
    if (this.pos >= s.length) return undefined;
    const ch = s[this.pos];
    if (ch === "/") return new PdfName(this.name());
    if (ch === "(") return this.literal();
    if (ch === "<") {
      if (s[this.pos + 1] === "<") {
        this.pos += 2;
        const dict: PdfDict = new Map();
        for (;;) {
          this.skip();
          if (s.startsWith(">>", this.pos)) {
            this.pos += 2;
            break;
          }
          if (this.pos >= s.length) break;
          const key = this.value();
          if (!(key instanceof PdfName)) break;
          const val = this.value();
          if (val === undefined) break;
          dict.set(key.name, val);
        }
        return dict;
      }
      return this.hex();
    }
    if (ch === "[") {
      this.pos++;
      const arr: PdfValue[] = [];
      for (;;) {
        this.skip();
        if (s[this.pos] === "]") {
          this.pos++;
          break;
        }
        if (this.pos >= s.length) break;
        const val = this.value();
        if (val === undefined) break;
        arr.push(val);
      }
      return arr;
    }
    if (ch === "]" || ch === ">") {
      this.pos++;
      return undefined;
    }
    if (ch === "{" || ch === "}") {
      this.pos++;
      return null;
    }
    const w = this.word();
    if (w === "") {
      this.pos++;
      return null;
    }
    if (w === "true") return true;
    if (w === "false") return false;
    if (w === "null") return null;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      const n = Number(w);
      // "12 0 R" 是引用
      if (/^\d+$/.test(w)) {
        const save = this.pos;
        this.skip();
        const gen = this.word();
        if (/^\d+$/.test(gen)) {
          this.skip();
          if (this.s[this.pos] === "R" && (this.pos + 1 >= s.length || WS.has(s.charCodeAt(this.pos + 1)) || DELIM.has(s.charCodeAt(this.pos + 1)))) {
            this.pos++;
            return new PdfRef(n, Number(gen));
          }
        }
        this.pos = save;
      }
      return n;
    }
    // 别的关键字（obj、stream 之类）当成名字一样的标记交回去
    return new PdfName("@" + w);
  }
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

function toBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
}

/** zlib 解压。末尾有多余字节、或者压坏了一截，能解多少算多少 */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  try {
    const ds = new DecompressionStream("deflate");
    const writer = ds.writable.getWriter();
    writer.write(data as BufferSource).catch(() => undefined);
    writer.close().catch(() => undefined);
    const reader = ds.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch {
    // 解到哪算哪
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

class Pdf {
  readonly objects = new Map<number, PdfValue>();
  private decoded = new Map<PdfStream, Promise<Uint8Array>>();
  trailer: PdfDict = new Map();

  constructor(readonly bytes: Uint8Array) {
    const text = latin1(bytes);
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      // "12 0 obj" 前面得是行首或空白，不然是别的数字粘上的
      if (m.index > 0 && !WS.has(text.charCodeAt(m.index - 1))) continue;
      const lex = new Lexer(text, m.index + m[0].length);
      const val = lex.value();
      if (val === undefined) continue;
      let obj: PdfValue = val;
      lex.skip();
      if (val instanceof Map && text.startsWith("stream", lex.pos)) {
        let start = lex.pos + 6;
        if (text[start] === "\r") start++;
        if (text[start] === "\n") start++;
        const len = val.get("Length");
        let end = typeof len === "number" ? start + len : -1;
        if (end < 0 || end > text.length || !/^\s*endstream/.test(text.slice(end, end + 30))) {
          end = text.indexOf("endstream", start);
          if (end < 0) end = text.length;
          // 去掉 endstream 前面的换行
          while (end > start && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
        }
        obj = new PdfStream(val, bytes.subarray(start, end));
        re.lastIndex = end;
      } else {
        re.lastIndex = Math.max(re.lastIndex, lex.pos);
      }
      this.objects.set(Number(m[1]), obj);
    }
    // 尾部的 trailer 字典（老式交叉引用表才有；新式的在 XRef 流里）
    const t = text.lastIndexOf("trailer");
    if (t >= 0) {
      const val = new Lexer(text, t + 7).value();
      if (val instanceof Map) this.trailer = val;
    }
    if (!this.trailer.get("Root")) {
      for (const obj of this.objects.values()) {
        if (obj instanceof PdfStream && this.nameOf(obj.dict.get("Type")) === "XRef") {
          this.trailer = obj.dict;
        }
      }
    }
  }

  /** 把压在对象流里的对象解出来 */
  async unpackObjectStreams(): Promise<void> {
    for (const obj of [...this.objects.values()]) {
      if (!(obj instanceof PdfStream) || this.nameOf(obj.dict.get("Type")) !== "ObjStm") continue;
      const data = latin1(await this.decode(obj));
      const n = Number(obj.dict.get("N")) || 0;
      const first = Number(obj.dict.get("First")) || 0;
      const head = new Lexer(data.slice(0, first));
      const pairs: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const num = head.value();
        const off = head.value();
        if (typeof num !== "number" || typeof off !== "number") break;
        pairs.push([num, off]);
      }
      for (const [num, off] of pairs) {
        if (this.objects.has(num)) continue;
        const val = new Lexer(data, first + off).value();
        if (val !== undefined) this.objects.set(num, val);
      }
    }
  }

  get(v: PdfValue | undefined, depth = 0): PdfValue | undefined {
    if (v instanceof PdfRef && depth < 16) return this.get(this.objects.get(v.num), depth + 1);
    return v;
  }

  dict(v: PdfValue | undefined): PdfDict | null {
    const r = this.get(v);
    if (r instanceof Map) return r;
    if (r instanceof PdfStream) return r.dict;
    return null;
  }

  array(v: PdfValue | undefined): PdfValue[] {
    const r = this.get(v);
    return Array.isArray(r) ? r : r === undefined || r === null ? [] : [r];
  }

  num(v: PdfValue | undefined, fallback = 0): number {
    const r = this.get(v);
    return typeof r === "number" ? r : fallback;
  }

  nameOf(v: PdfValue | undefined): string {
    const r = this.get(v);
    return r instanceof PdfName ? r.name : "";
  }

  async decode(stream: PdfStream): Promise<Uint8Array> {
    let p = this.decoded.get(stream);
    if (!p) {
      p = (async () => {
        const filters = this.array(stream.dict.get("Filter")).map((f) => this.nameOf(f));
        let data = stream.raw;
        for (const f of filters) {
          if (f === "FlateDecode" || f === "Fl") data = await inflate(data);
          else return new Uint8Array(0); // 别的压缩方式课表 PDF 里用不上，不认
        }
        return data;
      })();
      this.decoded.set(stream, p);
    }
    return p;
  }
}

// ---------- 字体 ----------

interface Font {
  /** 一个字符占几个字节 */
  bytes: number;
  unicode: Map<number, string>;
  width: (code: number) => number;
}

function utf16be(s: string): string {
  let out = "";
  for (let i = 0; i + 1 < s.length; i += 2) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
  return out;
}

function hexCode(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 256 + s.charCodeAt(i);
  return n;
}

/** 读 ToUnicode 对照表：字符码 → 文字 */
function parseCMap(text: string): { map: Map<number, string>; bytes: number } {
  const map = new Map<number, string>();
  let bytes = 0;
  const lex = new Lexer(text);
  const take = (): PdfValue | undefined => lex.value();
  for (;;) {
    const v = take();
    if (v === undefined) {
      if (lex.pos >= text.length) break;
      continue;
    }
    if (!(v instanceof PdfName)) continue;
    if (v.name === "@begincodespacerange") {
      const lo = take();
      take();
      if (typeof lo === "string") bytes = Math.max(bytes, lo.length);
    } else if (v.name === "@beginbfchar") {
      for (;;) {
        const src = take();
        if (!(typeof src === "string")) break;
        const dst = take();
        if (typeof dst === "string") map.set(hexCode(src), utf16be(dst));
      }
    } else if (v.name === "@beginbfrange") {
      for (;;) {
        const lo = take();
        if (!(typeof lo === "string")) break;
        const hi = take();
        const dst = take();
        if (typeof hi !== "string") break;
        const a = hexCode(lo);
        const b = Math.min(hexCode(hi), a + 0xffff);
        if (typeof dst === "string") {
          const base = utf16be(dst);
          const head = base.slice(0, -1);
          const last = base.charCodeAt(base.length - 1);
          for (let c = a; c <= b; c++) map.set(c, head + String.fromCharCode(last + (c - a)));
        } else if (Array.isArray(dst)) {
          dst.forEach((d, i) => {
            if (typeof d === "string") map.set(a + i, utf16be(d));
          });
        }
      }
    }
  }
  return { map, bytes };
}

async function loadFont(pdf: Pdf, ref: PdfValue | undefined): Promise<Font> {
  const font = pdf.dict(ref) ?? new Map();
  const subtype = pdf.nameOf(font.get("Subtype"));
  let unicode = new Map<number, string>();
  let bytes = subtype === "Type0" ? 2 : 1;
  const tu = pdf.get(font.get("ToUnicode"));
  if (tu instanceof PdfStream) {
    const parsed = parseCMap(latin1(await pdf.decode(tu)));
    unicode = parsed.map;
    if (subtype === "Type0" && parsed.bytes) bytes = parsed.bytes;
  }

  if (subtype === "Type0") {
    const desc = pdf.dict(pdf.array(font.get("DescendantFonts"))[0]) ?? new Map();
    const dw = pdf.num(desc.get("DW"), 1000);
    const widths = new Map<number, number>();
    const w = pdf.array(desc.get("W")).map((x) => pdf.get(x));
    for (let i = 0; i < w.length; ) {
      const first = w[i];
      const next = w[i + 1];
      if (typeof first !== "number") break;
      if (Array.isArray(next)) {
        next.forEach((x, j) => widths.set(first + j, pdf.num(x)));
        i += 2;
      } else {
        const last = typeof next === "number" ? next : first;
        const width = pdf.num(w[i + 2]);
        for (let c = first; c <= last && c - first < 0xffff; c++) widths.set(c, width);
        i += 3;
      }
    }
    return { bytes, unicode, width: (c) => widths.get(c) ?? dw };
  }

  const firstChar = pdf.num(font.get("FirstChar"));
  const widths = pdf.array(font.get("Widths")).map((x) => pdf.num(x));
  // 标准 14 种字体没写宽度，按 0.5 个字宽估
  return { bytes, unicode, width: (c) => widths[c - firstChar] ?? 500 };
}

// ---------- 内容流 ----------

type Matrix = [number, number, number, number, number, number];

function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

interface Ctx {
  pdf: Pdf;
  page: number;
  out: PdfText[];
  fonts: Map<PdfValue, Promise<Font>>;
  depth: number;
}

async function runContent(ctx: Ctx, data: string, resources: PdfDict | null, start: Matrix): Promise<void> {
  const { pdf } = ctx;
  const fontDict = pdf.dict(resources?.get("Font"));
  const xobjects = pdf.dict(resources?.get("XObject"));
  const lex = new Lexer(data);
  const stack: PdfValue[] = [];

  let ctm: Matrix = start;
  const saved: Matrix[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let font: Font | null = null;
  let fontSize = 0;
  let charSpace = 0;
  let wordSpace = 0;
  let scale = 1;
  let leading = 0;
  let rise = 0;
  const marks: (number | null)[] = [];

  const mcid = (): number | null => {
    for (let i = marks.length - 1; i >= 0; i--) if (marks[i] !== null) return marks[i];
    return null;
  };

  const newLine = (tx: number, ty: number) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };

  /** 显示一串字（TJ 里的一段），文字和位置记下来，文字矩阵往后挪 */
  const show = (raw: string, pieces: { str: string; x0: number; x1: number; y: number; size: number }[]) => {
    if (!font) return;
    const f = font;
    let text = "";
    let advance = 0;
    for (let i = 0; i + f.bytes <= raw.length; i += f.bytes) {
      let code = 0;
      for (let k = 0; k < f.bytes; k++) code = code * 256 + raw.charCodeAt(i + k);
      text += f.unicode.get(code) ?? (f.bytes === 1 ? String.fromCharCode(code) : "");
      advance += ((f.width(code) / 1000) * fontSize + charSpace + (f.bytes === 1 && code === 32 ? wordSpace : 0)) * scale;
    }
    const trm = mul(mul([fontSize * scale, 0, 0, fontSize, 0, rise], tm), ctm);
    const x0 = trm[4];
    const y = trm[5];
    const end = mul(mul([1, 0, 0, 1, advance, 0], tm), ctm);
    const size = Math.hypot(trm[2], trm[3]);
    pieces.push({ str: text, x0, x1: end[4], y, size });
    tm = mul([1, 0, 0, 1, advance, 0], tm);
  };

  /** 一次 Tj / TJ 显示的东西：挨得近的拼成一段；中间空得多（超过四分之一个字宽）就断开 */
  const flush = (pieces: { str: string; x0: number; x1: number; y: number; size: number }[]) => {
    let cur: PdfText | null = null;
    for (const p of pieces) {
      if (!p.str) continue;
      if (cur && Math.abs(p.y - cur.y) < p.size * 0.2 && p.x0 - cur.x1 < p.size * 0.25) {
        if (p.x0 - cur.x1 > p.size * 0.12 && !cur.str.endsWith(" ") && !p.str.startsWith(" ")) cur.str += " ";
        cur.str += p.str;
        cur.x1 = Math.max(cur.x1, p.x1);
      } else {
        if (cur) ctx.out.push(cur);
        cur = { str: p.str, x: p.x0, x1: p.x1, y: p.y, size: p.size, page: ctx.page, mcid: mcid() };
      }
    }
    if (cur) ctx.out.push(cur);
  };

  for (;;) {
    lex.skip();
    if (lex.pos >= data.length) break;
    const v = lex.value();
    if (v === undefined) continue;
    if (!(v instanceof PdfName) || !v.name.startsWith("@")) {
      stack.push(v);
      continue;
    }
    const op = v.name.slice(1);
    const args = stack.splice(0);
    const n = (i: number) => (typeof args[i] === "number" ? (args[i] as number) : 0);
    switch (op) {
      case "q":
        saved.push(ctm);
        break;
      case "Q":
        ctm = saved.pop() ?? ctm;
        break;
      case "cm":
        ctm = mul([n(0), n(1), n(2), n(3), n(4), n(5)], ctm);
        break;
      case "BT":
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case "Tf": {
        const name = args[0] instanceof PdfName ? args[0].name : "";
        fontSize = n(1);
        const ref = fontDict?.get(name);
        if (ref !== undefined) {
          let p = ctx.fonts.get(ref);
          if (!p) {
            p = loadFont(pdf, ref);
            ctx.fonts.set(ref, p);
          }
          font = await p;
        } else font = null;
        break;
      }
      case "Tc":
        charSpace = n(0);
        break;
      case "Tw":
        wordSpace = n(0);
        break;
      case "Tz":
        scale = n(0) / 100;
        break;
      case "TL":
        leading = n(0);
        break;
      case "Ts":
        rise = n(0);
        break;
      case "Td":
        newLine(n(0), n(1));
        break;
      case "TD":
        leading = -n(1);
        newLine(n(0), n(1));
        break;
      case "Tm":
        tlm = [n(0), n(1), n(2), n(3), n(4), n(5)];
        tm = tlm;
        break;
      case "T*":
        newLine(0, -leading);
        break;
      case "Tj":
      case "'":
      case '"': {
        if (op === '"') {
          wordSpace = n(0);
          charSpace = n(1);
        }
        if (op !== "Tj") newLine(0, -leading);
        const s = args[args.length - 1];
        const pieces: { str: string; x0: number; x1: number; y: number; size: number }[] = [];
        if (typeof s === "string") show(s, pieces);
        flush(pieces);
        break;
      }
      case "TJ": {
        const arr = Array.isArray(args[0]) ? args[0] : [];
        const pieces: { str: string; x0: number; x1: number; y: number; size: number }[] = [];
        for (const item of arr) {
          if (typeof item === "string") show(item, pieces);
          else if (typeof item === "number") tm = mul([1, 0, 0, 1, (-item / 1000) * fontSize * scale, 0], tm);
        }
        flush(pieces);
        break;
      }
      case "BMC":
        marks.push(null);
        break;
      case "BDC": {
        const props = args[1];
        let id: number | null = null;
        if (props instanceof Map) {
          const m = props.get("MCID");
          if (typeof m === "number") id = m;
        }
        marks.push(id);
        break;
      }
      case "EMC":
        marks.pop();
        break;
      case "BI": {
        // 内嵌图片：跳到 EI
        const end = data.indexOf("EI", lex.pos);
        lex.pos = end < 0 ? data.length : end + 2;
        break;
      }
      case "Do": {
        if (ctx.depth > 8) break;
        const name = args[0] instanceof PdfName ? args[0].name : "";
        const xo = pdf.get(xobjects?.get(name));
        if (xo instanceof PdfStream && pdf.nameOf(xo.dict.get("Subtype")) === "Form") {
          const m = pdf.array(xo.dict.get("Matrix")).map((x) => pdf.num(x));
          const matrix: Matrix = m.length === 6 ? (m as Matrix) : IDENTITY;
          const res = pdf.dict(xo.dict.get("Resources")) ?? resources;
          ctx.depth++;
          await runContent(ctx, latin1(await pdf.decode(xo)), res, mul(matrix, ctm));
          ctx.depth--;
        }
        break;
      }
      default:
        break;
    }
  }
}

// ---------- 页面和标签树 ----------

function collectPages(pdf: Pdf, node: PdfValue | undefined, out: { ref: number; dict: PdfDict; inherited: PdfDict }[], inherited: PdfDict, depth = 0): void {
  if (depth > 32) return;
  const dict = pdf.dict(node);
  if (!dict) return;
  const type = pdf.nameOf(dict.get("Type"));
  const res = dict.get("Resources");
  const next: PdfDict = new Map(inherited);
  if (res !== undefined) next.set("Resources", res);
  if (type === "Pages" || dict.has("Kids")) {
    for (const kid of pdf.array(dict.get("Kids"))) collectPages(pdf, kid, out, next, depth + 1);
  } else {
    out.push({ ref: node instanceof PdfRef ? node.num : -1, dict, inherited: next });
  }
}

function readTags(pdf: Pdf, root: PdfDict, pageIndex: Map<number, number>): PdfTag | null {
  const tree = pdf.dict(root.get("StructTreeRoot"));
  if (!tree) return null;
  const roleMap = pdf.dict(tree.get("RoleMap"));
  const role = (s: string): string => {
    let cur = s;
    for (let i = 0; i < 4; i++) {
      const mapped = roleMap ? pdf.nameOf(roleMap.get(cur)) : "";
      if (!mapped) break;
      cur = mapped;
    }
    return cur;
  };
  const seen = new Set<PdfDict>();
  let count = 0;

  const walk = (value: PdfValue | undefined, page: number): PdfTag | { page: number; mcid: number } | null => {
    if (++count > 200_000) return null;
    const v = pdf.get(value);
    if (typeof v === "number") return page >= 0 ? { page, mcid: v } : null;
    const dict = pdf.dict(v);
    if (!dict || seen.has(dict)) return null;
    seen.add(dict);
    const pg = dict.get("Pg");
    const here = pg instanceof PdfRef ? (pageIndex.get(pg.num) ?? page) : page;
    const type = pdf.nameOf(dict.get("Type"));
    if (type === "MCR") {
      const id = pdf.num(dict.get("MCID"), -1);
      return id >= 0 && here >= 0 ? { page: here, mcid: id } : null;
    }
    if (type === "OBJR") return null;
    const tag: PdfTag = { type: role(pdf.nameOf(dict.get("S"))), kids: [] };
    for (const kid of pdf.array(dict.get("K"))) {
      const child = walk(kid, here);
      if (child) tag.kids.push(child);
    }
    return tag;
  };

  const top: PdfTag = { type: "Root", kids: [] };
  for (const kid of pdf.array(tree.get("K"))) {
    const child = walk(kid, -1);
    if (child) top.kids.push(child);
  }
  return top;
}

/**
 * 有的 PDF 一个字一个字地画（浏览器打印出来的就是），按画的顺序把同一行、挨着的字拼回一段。
 * 中间隔得稍远（超过 0.15 个字宽）补一个空格
 */
function joinGlyphs(items: PdfText[]): PdfText[] {
  const out: PdfText[] = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    const size = Math.max(it.size, prev?.size ?? 0, 1);
    const gap = prev ? it.x - prev.x1 : 0;
    if (
      prev &&
      prev.page === it.page &&
      prev.mcid === it.mcid &&
      Math.abs(prev.y - it.y) < size * 0.3 &&
      gap > -size * 0.3 &&
      gap < size * 0.3
    ) {
      if (gap > size * 0.15 && !prev.str.endsWith(" ") && !it.str.startsWith(" ")) prev.str += " ";
      prev.str += it.str;
      prev.x1 = Math.max(prev.x1, it.x1);
    } else {
      out.push({ ...it });
    }
  }
  return out;
}

/** 读整份 PDF：每页的文字和位置，加上标签树（有的话） */
export async function readPdf(bytes: Uint8Array): Promise<PdfDoc> {
  const head = latin1(bytes.subarray(0, 1024));
  if (!head.includes("%PDF")) throw new Error("not pdf");
  const pdf = new Pdf(bytes);
  if (pdf.trailer.get("Encrypt") !== undefined) throw new Error("encrypted");
  await pdf.unpackObjectStreams();
  let root = pdf.dict(pdf.trailer.get("Root"));
  if (!root) {
    for (const obj of pdf.objects.values()) {
      if (obj instanceof Map && pdf.nameOf(obj.get("Type")) === "Catalog") root = obj;
    }
  }
  if (!root) throw new Error("no catalog");

  const pages: { ref: number; dict: PdfDict; inherited: PdfDict }[] = [];
  collectPages(pdf, root.get("Pages"), pages, new Map());
  const pageIndex = new Map<number, number>();
  pages.forEach((p, i) => pageIndex.set(p.ref, i));

  const fonts = new Map<PdfValue, Promise<Font>>();
  const out: PdfText[][] = [];
  for (let i = 0; i < pages.length && i < 60; i++) {
    const { dict, inherited } = pages[i];
    const resources = pdf.dict(dict.get("Resources") ?? inherited.get("Resources"));
    const parts: string[] = [];
    for (const c of pdf.array(dict.get("Contents"))) {
      const s = pdf.get(c);
      if (s instanceof PdfStream) parts.push(latin1(await pdf.decode(s)));
    }
    const ctx: Ctx = { pdf, page: i, out: [], fonts, depth: 0 };
    await runContent(ctx, parts.join("\n"), resources, IDENTITY);
    out.push(joinGlyphs(ctx.out));
  }
  return { pages: out, tags: readTags(pdf, root, pageIndex) };
}

// 给测试和别的模块用：字符串转字节
export const _internal = { toBytes, parseCMap };
