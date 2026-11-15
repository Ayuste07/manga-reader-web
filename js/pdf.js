// Carga de PDFs con pdf.js. El archivo se lee POR TROZOS desde el Blob guardado
// (PDFDataRangeTransport): un PDF de 300 MB no se carga entero en memoria.
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';

const CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/';
pdfjsLib.GlobalWorkerOptions.workerSrc = CDN + 'build/pdf.worker.min.mjs';

const CHUNK = 1 << 20; // 1 MB

const COMMON = {
  cMapUrl: CDN + 'cmaps/',
  cMapPacked: true,
  standardFontDataUrl: CDN + 'standard_fonts/',
  isEvalSupported: false,
  disableAutoFetch: true,   // solo pide los bytes de las páginas que se renderizan
  disableStream: true,
};

export async function openPdf(blob) {
  if (blob.size <= CHUNK * 2) {
    const data = new Uint8Array(await blob.arrayBuffer());
    return pdfjsLib.getDocument({ ...COMMON, data }).promise;
  }
  const initial = new Uint8Array(await blob.slice(0, CHUNK).arrayBuffer());
  const transport = new pdfjsLib.PDFDataRangeTransport(blob.size, initial);
  transport.requestDataRange = (begin, end) => {
    blob.slice(begin, end).arrayBuffer().then((buffer) => {
      transport.onDataRange(begin, new Uint8Array(buffer));
    });
  };
  return pdfjsLib.getDocument({ ...COMMON, range: transport, length: blob.size, rangeChunkSize: CHUNK / 2 }).promise;
}

/** Proporción alto/ancho de cada página (con rotación). Se calcula al importar y se guarda. */
export async function computeRatios(pdf, onProgress) {
  const ratios = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    ratios.push(viewport.height / viewport.width);
    page.cleanup();
    onProgress?.(n, pdf.numPages);
  }
  return ratios;
}

export async function renderThumbnail(pdf, width = 360) {
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  canvas.width = canvas.height = 0;
  return blob;
}
