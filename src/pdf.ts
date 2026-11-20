export interface PdfPage {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

/**
 * Writes a PDF with one JPEG per page, embedded as-is (no re-encoding).
 * `dpi` sets the printed size: a 3000px-tall photo at 300dpi is a 10in page.
 */
export function buildPdf(pages: PdfPage[], dpi = 300): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === "string" ? enc.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (id: number, body: string | (string | Uint8Array)[]) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    for (const part of Array.isArray(body) ? body : [body]) push(part);
    push("\nendobj\n");
  };

  // Object 1 is the catalog, 2 the page tree, then three objects per page.
  const pageId = (i: number) => 3 + i * 3;
  const scale = 72 / dpi;

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  const kids = pages.map((_, i) => `${pageId(i)} 0 R`).join(" ");
  object(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);

  pages.forEach((page, i) => {
    const id = pageId(i);
    const w = round(page.width * scale);
    const h = round(page.height * scale);
    object(
      id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
        `/Resources << /XObject << /Im0 ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>`,
    );
    object(id + 1, [
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
      page.jpeg,
      "\nendstream",
    ]);
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    object(id + 2, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  const count = 3 + pages.length * 3;
  const xref = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

const round = (n: number) => Math.round(n * 100) / 100;
