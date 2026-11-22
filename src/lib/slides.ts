// 课件读成文字：PDF、PowerPoint（.pptx）、纯文字（.txt / .md）。
// 只要文字，用来整理这门课的术语和提纲；图片、扫描件读不出字。

import { readPdf, type PdfDoc } from "./pdf";

/** PDF 每页按从上到下、从左到右排成一行行 */
export function pdfToText(doc: PdfDoc): string {
  return doc.pages
    .map((items) => {
      const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
      const lines: { y: number; size: number; parts: string[] }[] = [];
      for (const it of sorted) {
        const line = lines[lines.length - 1];
        if (line && Math.abs(line.y - it.y) <= Math.max(2, Math.min(line.size, it.size) * 0.5)) {
          line.parts.push(it.str);
        } else {
          lines.push({ y: it.y, size: it.size, parts: [it.str] });
        }
      }
      return lines
        .map((l) => l.parts.join(" ").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

// ---------- .pptx：一个 zip，每页一个 ppt/slides/slideN.xml ----------

interface ZipEntry {
  name: string;
  method: number;
  size: number;
  offset: number;
}

function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 从后往前找目录结尾的标记
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not zip");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let n = 0; n < count && at + 46 <= bytes.length; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    out.push({ name, method, size, offset });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function zipRead(bytes: Uint8Array, entry: ZipEntry): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameLen = view.getUint16(entry.offset + 26, true);
  const extraLen = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLen + extraLen;
  const data = bytes.subarray(start, start + entry.size);
  if (entry.method === 0) return new TextDecoder().decode(data);
  if (entry.method !== 8) throw new Error("unsupported zip method");
  if (typeof DecompressionStream === "undefined") throw new Error("no decompression");
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(stream).text();
}

function xmlText(xml: string): string {
  const decode = (s: string) =>
    s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
      .replace(/&amp;/g, "&");
  return xml
    .split(/<\/a:p>/)
    .map((para) =>
      [...para.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g)]
        .map((m) => decode(m[1]))
        .join("")
        .trim(),
    )
    .filter(Boolean)
    .join("\n");
}

export async function pptxToText(bytes: Uint8Array): Promise<string> {
  const entries = zipEntries(bytes)
    .map((e) => ({ e, n: /^ppt\/slides\/slide(\d+)\.xml$/.exec(e.name) }))
    .filter((x): x is { e: ZipEntry; n: RegExpExecArray } => x.n !== null)
    .sort((a, b) => Number(a.n[1]) - Number(b.n[1]));
  const pages: string[] = [];
  for (const { e } of entries.slice(0, 300)) pages.push(xmlText(await zipRead(bytes, e)));
  return pages.filter(Boolean).join("\n\n");
}

/** 读一份课件，出错时抛出中文说明 */
export async function readSlides(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    if (name.endsWith(".pdf")) return pdfToText(await readPdf(bytes, 300));
    if (name.endsWith(".pptx")) return await pptxToText(bytes);
    if (name.endsWith(".txt") || name.endsWith(".md")) return new TextDecoder().decode(bytes);
  } catch (e) {
    if (e instanceof Error && e.message === "encrypted") throw new Error("这份 PDF 加了密码，读不出来");
    if (e instanceof Error && e.message === "no decompression")
      throw new Error("这台电脑上读不了 PPT，导出成 PDF 再传");
    throw new Error("这份课件读不出来，换成 PDF 试试");
  }
  throw new Error("只能传 PDF、PPT（.pptx）或者文字文件");
}
