import { db } from './db.js';
import { getProgress, clearProgress } from './settings.js';

const $ = (selector) => document.querySelector(selector);
const libraryEl = $('#library');
const gridEl = $('#grid');
const continueEl = $('#continue');
const emptyEl = $('#empty');

let items = [];
const thumbUrls = new Map();
let activeReader = null;
let libraryScroll = 0;

// ---------- Utilidades ----------

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
export function toast(message, ms = 2600) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function progressOf(item) {
  const p = getProgress(item.id);
  const current = p ? p.currentPage : -1;
  return {
    position: p,
    current,
    fraction: p ? Math.min(1, (current + 1) / item.pageCount) : 0,
    finished: current >= item.pageCount - 1,
    lastOpened: p?.at || 0,
  };
}

async function thumbUrl(id) {
  if (thumbUrls.has(id)) return thumbUrls.get(id);
  const blob = await db.getThumb(id);
  const url = blob ? URL.createObjectURL(blob) : '';
  thumbUrls.set(id, url);
  return url;
}

// ---------- Biblioteca ----------

async function loadLibrary() {
  items = await db.allItems();
  await render();
}

function sortedItems() {
  return [...items].sort((a, b) => (progressOf(b).lastOpened || b.addedAt) - (progressOf(a).lastOpened || a.addedAt));
}

async function render() {
  emptyEl.hidden = items.length > 0;
  const sorted = sortedItems();

  const recent = sorted.find((item) => { const p = progressOf(item); return p.position && !p.finished; });
  if (recent) {
    const p = progressOf(recent);
    continueEl.innerHTML = `
      <button class="continue-card" data-open="${recent.id}">
        <img class="cover" alt="" src="${await thumbUrl(recent.id)}">
        <span class="continue-info">
          <span class="eyebrow">Continuar leyendo</span>
          <span class="title">${escapeHtml(recent.title)}</span>
          <span class="meta">Página ${p.current + 1} de ${recent.pageCount}</span>
          <span class="progress-line"><span style="width:${(p.fraction * 100).toFixed(1)}%"></span></span>
        </span>
        <svg class="play" viewBox="0 0 24 24" width="34" height="34" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#fff"/><path d="M10 7.5v9l7-4.5z" fill="#0a0a0a"/></svg>
      </button>`;
  } else {
    continueEl.innerHTML = '';
  }

  const cards = await Promise.all(sorted.map(async (item) => {
    const p = progressOf(item);
    const status = !p.position ? `Nuevo · ${item.pageCount} págs.` : p.finished ? 'Terminado' : `${p.current + 1} / ${item.pageCount}`;
    return `
      <article class="card">
        <button class="card-open" data-open="${item.id}" aria-label="Abrir ${escapeHtml(item.title)}">
          <span class="cover-wrap">
            <img class="cover" alt="" loading="lazy" src="${await thumbUrl(item.id)}">
            ${p.position ? `<span class="cover-progress" style="width:${(p.fraction * 100).toFixed(1)}%"></span>` : ''}
          </span>
          <span class="card-title">${escapeHtml(item.title)}</span>
        </button>
        <div class="card-foot">
          <span class="card-status">${status}</span>
          <button class="more" data-more="${item.id}" aria-label="Opciones">•••</button>
        </div>
      </article>`;
  }));
  gridEl.innerHTML = cards.join('');
}

libraryEl.addEventListener('click', (event) => {
  const open = event.target.closest('[data-open]');
  if (open) return openReader(open.dataset.open);
  const more = event.target.closest('[data-more]');
  if (more) return showItemMenu(more.dataset.more);
});

function showItemMenu(id) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  const sheet = document.createElement('div');
  sheet.className = 'sheet-backdrop';
  sheet.innerHTML = `
    <div class="sheet" role="dialog" aria-label="Opciones">
      <div class="sheet-title">${escapeHtml(item.title)}</div>
      <button data-act="rename">Renombrar</button>
      ${getProgress(id) ? '<button data-act="reset">Marcar como no leído</button>' : ''}
      <button data-act="delete" class="danger">Eliminar</button>
      <button data-act="cancel" class="cancel">Cancelar</button>
    </div>`;
  document.body.appendChild(sheet);
  requestAnimationFrame(() => sheet.classList.add('open'));
  const close = () => { sheet.classList.remove('open'); setTimeout(() => sheet.remove(), 220); };

  sheet.addEventListener('click', async (event) => {
    const action = event.target.dataset?.act;
    if (event.target === sheet || action === 'cancel') return close();
    if (!action) return;
    close();
    if (action === 'rename') {
      const title = prompt('Nuevo título', item.title)?.trim();
      if (title) { item.title = title; await db.putItem(item); render(); }
    } else if (action === 'reset') {
      clearProgress(id); render();
    } else if (action === 'delete') {
      if (confirm(`¿Eliminar «${item.title}»? Se borrará el PDF de la app.`)) {
        await db.remove(id);
        clearProgress(id);
        if (thumbUrls.get(id)) URL.revokeObjectURL(thumbUrls.get(id));
        thumbUrls.delete(id);
        items = items.filter((i) => i.id !== id);
        render();
      }
    }
  });
}

// ---------- Importar ----------

async function importFiles(files) {
  const pdfs = [...files].filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!pdfs.length) return;
  navigator.storage?.persist?.();          // pide al sistema no borrar los datos
  const { openPdf, computeRatios, renderThumbnail } = await import('./pdf.js');
  let failures = 0;

  for (const [index, file] of pdfs.entries()) {
    const label = pdfs.length > 1 ? ` (${index + 1}/${pdfs.length})` : '';
    toast(`Importando${label}…`, 0);
    let pdf;
    try {
      pdf = await openPdf(file);
      const ratios = await computeRatios(pdf, (n, total) => {
        if (n % 10 === 0 || n === total) toast(`Preparando${label}… ${n}/${total}`, 0);
      });
      const thumb = await renderThumbnail(pdf).catch(() => null);
      const item = {
        id: crypto.randomUUID(),
        title: file.name.replace(/\.pdf$/i, ''),
        pageCount: pdf.numPages,
        ratios,
        size: file.size,
        addedAt: Date.now(),
      };
      // Copia los bytes a un Blob propio (el File de un <input> puede dejar de ser legible).
      const blob = new Blob([await file.arrayBuffer()], { type: 'application/pdf' });
      await db.add(item, blob, thumb);
      items.push(item);
    } catch (error) {
      console.error(error);
      failures++;
    } finally {
      pdf?.destroy();
    }
  }
  await render();
  toast(failures ? `No se pudo importar ${failures} archivo(s).` : 'Listo ✓');
}

document.querySelectorAll('#file-input, .file-input-alt').forEach((input) => {
  input.addEventListener('change', () => {
    importFiles(input.files);
    input.value = '';
  });
});

// ---------- Lector ----------

async function openReader(id) {
  const item = items.find((i) => i.id === id);
  if (!item || activeReader) return;
  const blob = await db.getFile(id);
  if (!blob) return toast('No se encontró el archivo.');
  const { Reader } = await import('./reader.js');

  libraryScroll = window.scrollY;
  libraryEl.hidden = true;
  document.body.classList.add('reading');

  activeReader = new Reader($('#reader-root'), item, blob, {
    initialPosition: getProgress(id),
    onClose: () => {
      activeReader = null;
      document.body.classList.remove('reading');
      libraryEl.hidden = false;
      render().then(() => window.scrollTo(0, libraryScroll));
    },
  });
  window.__reader = activeReader;   // depuración desde la consola
  try {
    await activeReader.open();
  } catch (error) {
    console.error(error);
    toast('No se pudo abrir el PDF.');
    activeReader?.close();
  }
}

// ---------- Arranque ----------

const isStandalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
if (isIOS && !isStandalone && !localStorage.getItem('manga.hintDismissed')) {
  $('#install-hint').hidden = false;
}
$('#install-hint-close').addEventListener('click', () => {
  $('#install-hint').hidden = true;
  try { localStorage.setItem('manga.hintDismissed', '1'); } catch { /* ignore */ }
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js');
}

// Precarga pdf.js en segundo plano para que el primer manga abra al instante.
setTimeout(() => import('./pdf.js').catch(() => {}), 800);

loadLibrary();
