import { parentPort, workerData } from 'node:worker_threads';
import mammoth from 'mammoth';

const { bytes, mimeType } = workerData as { bytes: Uint8Array; mimeType: string };
async function extract() {
  if (mimeType === 'application/pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, useWasm: false, stopAtErrors: true });
    const document = await loading.promise;
    try {
      if (document.numPages > 200) throw new Error('PDF exceeds 200 pages');
      const pages: Array<{ page: number; text: string }> = []; let length = 0;
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items.map((item) => 'str' in item ? item.str : '').join(' ');
        length += text.length; if (length > 1000000) throw new Error('Document text exceeds 1,000,000 characters');
        pages.push({ page: pageNumber, text }); await page.cleanup();
      }
      return pages;
    } finally { await loading.destroy(); }
  }
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  if (result.value.length > 1000000) throw new Error('Document text exceeds 1,000,000 characters');
  return [{ page: 1, text: result.value }];
}
extract().then((pages) => parentPort?.postMessage({ pages }), (error: unknown) => parentPort?.postMessage({ error: error instanceof Error ? error.message : 'Document extraction failed' }));
