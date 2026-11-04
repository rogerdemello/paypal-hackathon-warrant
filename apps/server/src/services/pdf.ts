/**
 * A minimal text-only PDF writer, enough for the dispute evidence packet: PayPal accepts PDF evidence files, and a reviewer
 * opens this one in any viewer. No dependency, no fonts to embed (the standard Helvetica faces), A4 pages, wrapped lines.
 */

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 50;
const BODY_SIZE = 10;
const TITLE_SIZE = 16;
const LEADING = 13;
const MAX_CHARS = 92;
const LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - 2 * MARGIN) / LEADING);

/** Keep printable Latin-1, replace everything else, and escape the characters PDF strings treat specially. */
function pdfText(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if (ch === '\\' || ch === '(' || ch === ')') out += `\\${ch}`;
    else if (code >= 32 && code <= 126) out += ch;
    else if (code === 9) out += '    ';
    else if (code >= 160 && code <= 255) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += '?';
  }
  return out;
}

/** Wrap one logical line to the page width, breaking at spaces where possible and hard-breaking long tokens. */
export function wrapLine(line: string, width = MAX_CHARS): string[] {
  if (line.length <= width) return [line];
  const out: string[] = [];
  const indent = /^\s*/.exec(line)?.[0] ?? '';
  let rest = line;
  let first = true;
  while (rest.length > width) {
    const prefix = first ? '' : `${indent}  `;
    const room = width - prefix.length;
    let cut = rest.lastIndexOf(' ', room);
    if (cut <= prefix.length) cut = room;
    out.push(prefix + rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
    first = false;
  }
  out.push((first ? '' : `${indent}  `) + rest);
  return out;
}

export interface TextPdfOptions {
  readonly title: string;
  readonly lines: readonly string[];
}

/** Build a PDF document. Deterministic: the same input gives the same bytes. */
export function textPdf(options: TextPdfOptions): Uint8Array {
  const wrapped: string[] = [];
  for (const line of options.lines) wrapped.push(...wrapLine(line.replace(/\r/g, '')));
  const pages: string[][] = [];
  // The title takes the first lines of page one.
  const firstPageCapacity = LINES_PER_PAGE - 2;
  pages.push(wrapped.slice(0, firstPageCapacity));
  for (let i = firstPageCapacity; i < wrapped.length; i += LINES_PER_PAGE) pages.push(wrapped.slice(i, i + LINES_PER_PAGE));

  // Object numbers: 1 catalog, 2 pages, 3 font, 4 bold font, then (page, content) pairs.
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((pageLines, index) => {
    const pageId = 5 + index * 2;
    const contentId = pageId + 1;
    let stream = '';
    let y = PAGE_HEIGHT - MARGIN;
    if (index === 0) {
      stream += `BT /F2 ${TITLE_SIZE} Tf ${MARGIN} ${y - TITLE_SIZE} Td (${pdfText(options.title)}) Tj ET\n`;
      y -= TITLE_SIZE + 2 * LEADING;
    } else {
      y -= BODY_SIZE;
    }
    stream += `BT /F1 ${BODY_SIZE} Tf ${MARGIN} ${y} Td ${LEADING} TL\n`;
    for (const line of pageLines) stream += `(${pdfText(line)}) Tj T*\n`;
    stream += `ET\nBT /F1 8 Tf ${PAGE_WIDTH - MARGIN - 60} ${MARGIN - 25} Td (Page ${index + 1} of ${pages.length}) Tj ET\n`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`;
  });

  const chunks: string[] = ['%PDF-1.4\n'];
  const offsets: number[] = [];
  let length = chunks[0]?.length ?? 0;
  for (let id = 1; id < objects.length; id++) {
    const body = `${id} 0 obj\n${objects[id] ?? ''}\nendobj\n`;
    offsets[id] = length;
    chunks.push(body);
    length += Buffer.byteLength(body, 'latin1');
  }
  const xrefAt = length;
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  chunks.push(xref);
  return Buffer.from(chunks.join(''), 'latin1');
}
