const inputLimit = 32 * 1024 * 1024;
const textLimit = 1_000_000;
const pageLimit = 200;

async function readInput(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > inputLimit) throw new Error('Document exceeds 32 MB');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function extract(bytes: Buffer, mimeType: string) {
  if (mimeType === 'application/pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, useWasm: false, stopAtErrors: true });
    const document = await loading.promise;
    try {
      if (document.numPages > pageLimit) throw new Error('PDF exceeds 200 pages');
      const pages: Array<{ page: number; text: string }> = []; let length = 0;
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items.map((item) => 'str' in item ? item.str : '').join(' ');
        length += text.length; if (length > textLimit) throw new Error('Document text exceeds 1,000,000 characters');
        pages.push({ page: pageNumber, text }); await page.cleanup();
      }
      return pages;
    } finally { await loading.destroy(); }
  }
  const mammoth = (await import('mammoth')).default;
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  if (result.value.length > textLimit) throw new Error('Document text exceeds 1,000,000 characters');
  return [{ page: 1, text: result.value }];
}

async function main(): Promise<void> {
  const bytes = await readInput();
  const pages = await extract(bytes, process.argv[2] ?? '');
  process.stdout.write(JSON.stringify({ pages }));
}

void main().catch((error: unknown) => {
  process.stdout.write(JSON.stringify({
    error: error instanceof Error ? error.message.slice(0, 500) : 'Document extraction failed',
  }));
});
