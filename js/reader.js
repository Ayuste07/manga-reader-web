// Lector de scroll vertical continuo.
//
// - El scroll es el NATIVO de la página (inercia y rebote de iOS) y el zoom con dos dedos
//   es el NATIVO de Safari: no hay gestos propios que puedan competir entre sí.
// - Virtualización: solo existen <canvas> para las páginas cerca de la pantalla; el resto
//   son cajas vacías con su proporción exacta (el scroll no "salta").
// - Resolución adaptativa: base = ancho real en píxeles; con zoom ≥ 1,4× las páginas
//   visibles se re-renderizan al doble (máx. 2600 px) y bajan de nuevo al alejarse.
import { openPdf, computeRatios } from './pdf.js';
import { settings, saveSettings, setProgress } from './settings.js';

const MAX_PIXEL_WIDTH = 2600;
const MAX_CANVAS_PIXELS = 16_000_000;   // límite de Safari por canvas ≈ 16,7 M
const AUTO_HIDE_MS = 3000;

const icon = {
  close: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="20" height="20"><rect x="6.5" y="5.5" width="4" height="13" rx="1" fill="currentColor"/><rect x="13.5" y="5.5" width="4" height="13" rx="1" fill="currentColor"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="21" height="21"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  sunMin: '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>',
  sunMax: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></g></svg>',
  back: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

export class Reader {
  constructor(root, item, blob, { initialPosition, onClose }) {
    this.root = root;
    this.item = item;
    this.blob = blob;
    this.initialPosition = initialPosition;
    this.onClose = onClose;

    this.pages = [];          // { el, canvas, rendered, requested, task }
    this.tops = [];
    this.heights = [];
    this.currentPage = initialPosition?.currentPage ?? 0;
    this.zoom = 1;
    this.lastZoomChange = 0;
    this.controlsVisible = true;
    this.pinned = 0;
    this.returnPage = null;
    this.rendering = false;
    this.closed = false;
    this.auto = { running: false, paused: false, pos: 0, last: 0, raf: 0, resumeTimer: 0 };
    this.listeners = new AbortController();
    this.scheduled = false;
  }

  // ---------- Ciclo de vida ----------

  async open() {
    this.buildDom();
    this.pdf = await openPdf(this.blob);
    if (this.closed) return;
    let ratios = this.item.ratios;
    if (!Array.isArray(ratios) || ratios.length !== this.pdf.numPages) {
      ratios = await computeRatios(this.pdf);
    }
    this.buildPages(ratios);
    this.measure();
    this.restore(this.initialPosition);
    this.attachEvents();
    this.loadingEl.remove();
    this.update();
    this.syncPageUi();
    this.setControls(true);
    this.requestWakeLock();
  }

  close() {
    if (this.closed) return;
    this.saveProgress();
    this.closed = true;
    this.stopAutoScroll();
    this.listeners.abort();
    clearTimeout(this.hideTimer);
    clearTimeout(this.saveTimer);
    this.wakeLock?.release().catch(() => {});
    this.pages.forEach((_, i) => this.release(i));
    this.pdf?.destroy();
    this.root.innerHTML = '';
    document.documentElement.style.removeProperty('--gap');
    this.onClose?.();
  }

  // ---------- DOM ----------

  buildDom() {
    this.root.innerHTML = `
      <div class="reader ${settings.showPageNumbers ? '' : 'no-numbers'}">
        <div class="pages"></div>
        <div class="safe-probe" aria-hidden="true"></div>
        <div class="reader-loading"><div class="spinner"></div></div>
        <div class="filter warm" ${settings.warmFilter ? '' : 'hidden'}></div>
        <div class="filter dim"></div>
        <div class="mini-progress"><span></span></div>
        <div class="controls">
          <div class="bar top">
            <button class="icon-btn" data-act="close" aria-label="Cerrar">${icon.close}</button>
            <div class="reader-title"></div>
          </div>
          <div class="scrub-indicator" hidden></div>
          <div class="bar bottom">
            <button class="chip" data-act="return" hidden></button>
            <div class="row">
              <span class="page-now">1</span>
              <input class="slider page-slider" type="range" min="0" max="0" step="1" value="0" aria-label="Página">
              <span class="page-total">1</span>
            </div>
            <div class="row">
              <button class="round-btn" data-act="auto" aria-label="Auto-scroll">${icon.play}</button>
              <span class="muted">${icon.sunMin}</span>
              <input class="slider brightness" type="range" min="0.3" max="1" step="0.01" aria-label="Brillo">
              <span class="muted">${icon.sunMax}</span>
              <button class="round-btn" data-act="settings" aria-label="Ajustes">${icon.gear}</button>
            </div>
          </div>
        </div>
      </div>`;
    const q = (s) => this.root.querySelector(s);
    this.el = q('.reader');
    this.pagesEl = q('.pages');
    this.loadingEl = q('.reader-loading');
    this.controlsEl = q('.controls');
    this.slider = q('.page-slider');
    this.pageNowEl = q('.page-now');
    this.scrubEl = q('.scrub-indicator');
    this.returnEl = q('[data-act="return"]');
    this.autoBtn = q('[data-act="auto"]');
    this.dimEl = q('.dim');
    this.warmEl = q('.warm');
    this.miniEl = q('.mini-progress');
    this.brightness = q('.brightness');
    q('.reader-title').textContent = this.item.title;
    q('.page-total').textContent = this.item.pageCount;
    this.brightness.value = String(1 - settings.dimming);
    this.applyFilters();
    window.scrollTo(0, 0);
  }

  buildPages(ratios) {
    document.documentElement.style.setProperty('--gap', settings.pageGap + 'px');
    const total = ratios.length;
    const fragment = document.createDocumentFragment();
    this.pages = ratios.map((ratio, i) => {
      const el = document.createElement('div');
      el.className = 'page';
      el.style.aspectRatio = `1 / ${ratio}`;
      el.dataset.n = String(i + 1);
      el.dataset.label = i === total - 1 ? '— FIN —' : `${i + 1} / ${total}`;
      fragment.appendChild(el);
      return { el, canvas: null, rendered: 0, requested: 0, task: null };
    });
    this.pagesEl.appendChild(fragment);
    this.slider.max = String(total - 1);
    this.miniEl.hidden = !settings.miniProgress;
  }

  measure() {
    // getBoundingClientRect (no offsetTop): las alturas por aspect-ratio son fraccionarias.
    const rects = this.pages.map((p) => p.el.getBoundingClientRect());
    this.tops = rects.map((r) => r.top + window.scrollY);
    this.heights = rects.map((r) => r.height);
    const style = getComputedStyle(this.pagesEl);
    this.safeTop = parseFloat(style.paddingTop) || 0;
    this.safeBottom = parseFloat(getComputedStyle(this.root.querySelector('.safe-probe')).paddingBottom) || 0;
    this.layoutWidth = window.innerWidth;
  }

  // ---------- Geometría ----------

  viewport() {
    const vv = window.visualViewport;
    return vv
      ? { top: vv.pageTop, height: vv.height, scale: vv.scale }
      : { top: window.scrollY, height: window.innerHeight, scale: 1 };
  }

  /** Primera página cuyo final (incluido el hueco) queda por debajo de y. */
  pageIndexAt(y) {
    let low = 0, high = this.pages.length - 1;
    const gap = settings.pageGap;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.tops[mid] + this.heights[mid] + gap < y) low = mid + 1; else high = mid;
    }
    return low;
  }

  currentPosition() {
    const y = window.scrollY + this.safeTop;
    const i = this.pageIndexAt(y);
    const offset = this.heights[i] ? Math.min(Math.max((y - this.tops[i]) / this.heights[i], 0), 1) : 0;
    return { pageIndex: i, offsetInPage: offset, currentPage: this.currentPage };
  }

  restore(position) {
    if (!position || !this.pages[position.pageIndex]) return;
    const i = position.pageIndex;
    window.scrollTo(0, this.tops[i] + this.heights[i] * position.offsetInPage - this.safeTop);
  }

  jump(index) {
    window.scrollTo(0, this.tops[index] - this.safeTop);
    this.update();
  }

  /** Avance por toques: alinea la página siguiente arriba si ya asoma; si no, 85 % de pantalla. */
  advance(direction) {
    const visible = window.innerHeight - this.safeTop - this.safeBottom;
    const step = visible * 0.85;
    const top = window.scrollY + this.safeTop;
    const tolerance = 3;   // px: el scroll se redondea a píxeles físicos
    let target;
    if (direction > 0) {
      let next = this.pageIndexAt(top + tolerance);
      if (this.tops[next] <= top + tolerance) next++;
      const nextTop = next < this.pages.length ? this.tops[next] : Infinity;
      target = Math.min(nextTop, top + step);
    } else {
      let prev = this.pageIndexAt(top - tolerance);
      if (this.tops[prev] >= top - tolerance) prev = Math.max(prev - 1, 0);
      target = Math.max(this.tops[prev], top - step);
    }
    window.scrollTo({ top: target - this.safeTop, behavior: 'smooth' });
  }

  // ---------- Renderizado ----------

  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => { this.scheduled = false; if (!this.closed) this.update(); });
  }

  targetWidth(zoomed) {
    const css = this.pagesEl.clientWidth;
    const bucket = zoomed && this.zoom >= 1.4 ? 2 : 1;
    return Math.round(Math.min(css * (window.devicePixelRatio || 2) * bucket, MAX_PIXEL_WIDTH));
  }

  update() {
    if (!this.pages.length) return;
    const vp = this.viewport();
    // Canvas vivos: pantalla visible ± 1,5 pantallas.
    this.keepFrom = this.pageIndexAt(vp.top - vp.height * 1.5);
    this.keepTo = this.pageIndexAt(vp.top + vp.height * 2.5);
    const visibleFrom = this.pageIndexAt(vp.top);
    const visibleTo = this.pageIndexAt(vp.top + vp.height);
    const zooming = performance.now() - this.lastZoomChange < 250;

    this.pages.forEach((p, i) => {
      if (i < this.keepFrom || i > this.keepTo) {
        if (p.canvas || p.task) this.release(i);
        return;
      }
      if (zooming && p.rendered) return;          // no tocar nada a mitad de un pellizco
      const onScreen = i >= visibleFrom && i <= visibleTo;
      p.requested = this.targetWidth(onScreen);
    });

    this.updateCurrentPage(vp);
    this.pump();
  }

  /** Renderiza de una en una, empezando por la más cercana a la página actual. */
  async pump() {
    if (this.rendering || this.closed) return;
    let best = -1, bestDistance = Infinity;
    for (let i = this.keepFrom; i <= this.keepTo; i++) {
      const p = this.pages[i];
      if (p && p.requested && p.requested !== p.rendered) {
        const d = Math.abs(i - this.currentPage) + (i < this.currentPage ? 0.5 : 0); // prioriza hacia delante
        if (d < bestDistance) { bestDistance = d; best = i; }
      }
    }
    if (best < 0) return;
    this.rendering = true;
    try {
      await this.renderPage(best);
    } catch (error) {
      if (error?.name !== 'RenderingCancelledException') console.warn(error);
    } finally {
      this.rendering = false;
    }
    if (!this.closed) this.pump();
  }

  async renderPage(i) {
    const p = this.pages[i];
    const target = p.requested;
    const page = await this.pdf.getPage(i + 1);
    const base = page.getViewport({ scale: 1 });
    let scale = target / base.width;
    if (base.width * base.height * scale * scale > MAX_CANVAS_PIXELS) {
      scale = Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height));
    }
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    p.task = page.render({ canvasContext: ctx, viewport });
    try {
      await p.task.promise;
    } catch (error) {
      canvas.width = canvas.height = 0;
      throw error;
    } finally {
      p.task = null;
    }

    const stillWanted = !this.closed && p.requested === target && i >= this.keepFrom && i <= this.keepTo;
    if (!stillWanted) {
      canvas.width = canvas.height = 0;
      if (p.requested === target) p.requested = 0;
      return;
    }
    const first = !p.canvas;
    if (p.canvas) { p.canvas.remove(); p.canvas.width = p.canvas.height = 0; }
    if (first) canvas.classList.add('fade-in');
    p.el.appendChild(canvas);
    p.el.classList.add('loaded');
    p.canvas = canvas;
    p.rendered = target;
  }

  /** Libera el bitmap (Safari limita la memoria total de canvas) y la memoria de pdf.js. */
  release(i) {
    const p = this.pages[i];
    p.task?.cancel();
    p.task = null;
    if (p.canvas) {
      p.canvas.remove();
      p.canvas.width = p.canvas.height = 0;
      p.canvas = null;
      this.pdf?.getPage(i + 1).then((page) => page.cleanup()).catch(() => {});
    }
    p.el.classList.remove('loaded');
    p.rendered = 0;
    p.requested = 0;
  }

  updateCurrentPage(vp) {
    const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    const page = atBottom ? this.pages.length - 1 : this.pageIndexAt(vp.top + vp.height * 0.4);
    if (page === this.currentPage) return;
    this.currentPage = page;
    this.syncPageUi();
  }

  syncPageUi() {
    const page = this.currentPage;
    this.miniEl.firstElementChild.style.transform = `scaleX(${(page + 1) / this.pages.length})`;
    if (!this.scrubbing) {
      this.slider.value = String(page);
      this.pageNowEl.textContent = page + 1;
    }
    this.updateReturnChip();
  }

  // ---------- Progreso ----------

  saveProgress() {
    if (!this.pages.length || this.closed) return;
    setProgress(this.item.id, this.currentPosition());
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveProgress(), 400);
  }

  // ---------- Eventos ----------

  attachEvents() {
    const opts = { signal: this.listeners.signal };
    const passive = { signal: this.listeners.signal, passive: true };

    window.addEventListener('scroll', () => {
      this.lastScrollAt = performance.now();
      this.schedule();
      this.scheduleSave();
    }, passive);

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', () => {
        if (Math.abs(vv.scale - this.zoom) > 0.01) {
          this.zoom = vv.scale;
          this.lastZoomChange = performance.now();
          this.el.classList.toggle('zoomed', this.zoom > 1.05);
          if (this.zoom > 1.05) this.setControls(false, true);
          clearTimeout(this.zoomTimer);
          this.zoomTimer = setTimeout(() => this.update(), 260);   // al soltar: versión HD
        }
        this.schedule();
      }, passive);
      vv.addEventListener('scroll', () => this.schedule(), passive);
    }

    window.addEventListener('resize', () => {
      if (window.innerWidth === this.layoutWidth) return;     // solo rotación / cambio real
      const position = this.currentPosition();
      this.measure();
      this.restore(position);
      this.update();
    }, passive);

    // Arrastrar para leer → los controles se apartan solos.
    window.addEventListener('touchmove', (event) => {
      if (this.controlsEl.contains(event.target)) return;
      if (this.controlsVisible) this.setControls(false);
    }, passive);

    // Auto-scroll: se pausa mientras tocas y se reanuda al soltar.
    window.addEventListener('touchstart', (event) => {
      if (this.auto.running && !this.controlsEl.contains(event.target)) {
        this.auto.paused = true;
        clearTimeout(this.auto.resumeTimer);
      }
    }, passive);
    window.addEventListener('touchend', () => {
      if (this.auto.running && this.auto.paused) this.resumeWhenIdle();
    }, passive);

    this.pagesEl.addEventListener('click', (event) => this.onTap(event), opts);
    this.controlsEl.addEventListener('click', (event) => this.onControl(event), opts);

    // Selector de página
    const startScrub = () => {
      if (this.scrubbing) return;
      this.scrubbing = true;
      if (this.returnPage === null) this.returnPage = this.currentPage;
      this.pin(true);
      this.scrubEl.hidden = false;
    };
    const endScrub = () => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      this.scrubEl.hidden = true;
      if (this.returnPage === this.currentPage) this.returnPage = null;
      this.updateReturnChip();
      this.pin(false);
    };
    this.slider.addEventListener('pointerdown', startScrub, opts);
    this.slider.addEventListener('touchstart', startScrub, passive);
    this.slider.addEventListener('input', () => {
      startScrub();
      const page = Number(this.slider.value);
      this.pageNowEl.textContent = page + 1;
      this.scrubEl.textContent = page + 1;
      this.jump(page);
    }, opts);
    this.slider.addEventListener('change', endScrub, opts);
    this.slider.addEventListener('pointerup', endScrub, opts);
    this.slider.addEventListener('touchend', endScrub, passive);

    // Brillo
    this.brightness.addEventListener('pointerdown', () => this.pin(true), opts);
    this.brightness.addEventListener('input', () => {
      settings.dimming = +(1 - Number(this.brightness.value)).toFixed(2);
      this.applyFilters();
    }, opts);
    this.brightness.addEventListener('change', () => { saveSettings(); this.pin(false); }, opts);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.saveProgress();
      else this.requestWakeLock();
    }, opts);
    window.addEventListener('pagehide', () => this.saveProgress(), opts);
  }

  onTap(event) {
    if (this.zoom > 1.05) return;
    const y = event.clientY;
    const h = window.innerHeight;
    if (settings.tapZones && !this.auto.running && !this.controlsVisible) {
      if (y < h * 0.3) return this.advance(-1);
      if (y > h * 0.7) return this.advance(1);
    }
    this.setControls(!this.controlsVisible);
  }

  onControl(event) {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    this.scheduleHide();
    switch (button.dataset.act) {
      case 'close': return this.close();
      case 'auto': return this.auto.running ? this.stopAutoScroll() : this.startAutoScroll();
      case 'settings': return this.openSettings();
      case 'return': {
        const page = this.returnPage;
        this.returnPage = null;
        this.updateReturnChip();
        if (page !== null) this.jump(page);
        return;
      }
    }
  }

  // ---------- Controles (modo inmersivo) ----------

  setControls(visible, force = false) {
    if (!visible && this.pinned && !force) return;
    if (visible && this.zoom > 1.05) return;
    this.controlsVisible = visible;
    this.el.classList.toggle('show-controls', visible);
    if (!visible) {
      this.returnPage = null;
      this.updateReturnChip();
    }
    this.scheduleHide();
  }

  scheduleHide() {
    clearTimeout(this.hideTimer);
    if (!this.controlsVisible || this.pinned || this.returnPage !== null) return;
    this.hideTimer = setTimeout(() => this.setControls(false), AUTO_HIDE_MS);
  }

  pin(on) {
    this.pinned = Math.max(0, this.pinned + (on ? 1 : -1));
    if (this.pinned) clearTimeout(this.hideTimer); else this.scheduleHide();
  }

  updateReturnChip() {
    const show = this.returnPage !== null && this.returnPage !== this.currentPage;
    this.returnEl.hidden = !show;
    if (show) this.returnEl.innerHTML = `${icon.back} Volver a la página ${this.returnPage + 1}`;
  }

  applyFilters() {
    this.dimEl.style.opacity = String(settings.dimming);
    this.warmEl.hidden = !settings.warmFilter;
  }

  // ---------- Auto-scroll ----------

  startAutoScroll() {
    const a = this.auto;
    a.running = true;
    a.paused = false;
    a.last = 0;
    this.autoBtn.innerHTML = icon.pause;
    this.autoBtn.classList.add('active');
    const step = (t) => {
      if (!a.running) return;
      a.raf = requestAnimationFrame(step);
      if (a.paused) { a.last = 0; return; }
      if (!a.last) { a.last = t; a.pos = window.scrollY; return; }
      const dt = Math.min((t - a.last) / 1000, 0.1);
      a.last = t;
      a.pos += settings.autoScrollSpeed * dt;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (a.pos >= max) { window.scrollTo(0, max); this.stopAutoScroll(); return; }
      window.scrollTo(0, a.pos);
    };
    a.raf = requestAnimationFrame(step);
    this.setControls(false, true);
  }

  stopAutoScroll() {
    const a = this.auto;
    if (!a.running) return;
    a.running = false;
    cancelAnimationFrame(a.raf);
    clearTimeout(a.resumeTimer);
    this.autoBtn.innerHTML = icon.play;
    this.autoBtn.classList.remove('active');
  }

  resumeWhenIdle() {
    clearTimeout(this.auto.resumeTimer);
    this.auto.resumeTimer = setTimeout(() => {
      if (performance.now() - (this.lastScrollAt || 0) < 200) return this.resumeWhenIdle(); // aún con inercia
      this.auto.paused = false;
    }, 250);
  }

  // ---------- Pantalla encendida ----------

  async requestWakeLock() {
    if (!settings.keepAwake || !('wakeLock' in navigator) || this.closed) return;
    try { this.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* no soportado */ }
  }

  // ---------- Ajustes ----------

  openSettings() {
    this.pin(true);
    const sheet = document.createElement('div');
    sheet.className = 'sheet-backdrop';
    const check = (key, label) => `
      <label class="setting toggle"><span>${label}</span>
        <input type="checkbox" data-key="${key}" ${settings[key] ? 'checked' : ''}><i></i></label>`;
    sheet.innerHTML = `
      <div class="sheet settings" role="dialog" aria-label="Ajustes de lectura">
        <div class="sheet-handle"></div>
        <h3>Ajustes de lectura</h3>
        <div class="group">
          <label class="setting stacked"><span>Espacio entre páginas <b data-out="pageGap">${settings.pageGap} pt</b></span>
            <input class="slider" type="range" min="0" max="40" step="2" value="${settings.pageGap}" data-key="pageGap"></label>
          ${check('showPageNumbers', 'Número de página en la separación')}
          ${check('miniProgress', 'Barra de progreso mínima')}
        </div>
        <div class="group">
          ${check('tapZones', 'Zonas táctiles')}
          <p class="hint">Con los controles ocultos: toca abajo para avanzar y arriba para retroceder. El centro muestra los controles.</p>
        </div>
        <div class="group">
          <label class="setting stacked"><span>Velocidad del auto-scroll <b data-out="autoScrollSpeed">${settings.autoScrollSpeed} pt/s</b></span>
            <input class="slider" type="range" min="15" max="250" step="5" value="${settings.autoScrollSpeed}" data-key="autoScrollSpeed"></label>
        </div>
        <div class="group">
          ${check('keepAwake', 'Mantener la pantalla encendida')}
          ${check('warmFilter', 'Filtro cálido (lectura nocturna)')}
        </div>
        <button class="btn-primary block" data-act="done">Hecho</button>
      </div>`;
    this.root.appendChild(sheet);
    requestAnimationFrame(() => sheet.classList.add('open'));

    const close = () => {
      sheet.classList.remove('open');
      setTimeout(() => sheet.remove(), 220);
      this.pin(false);
    };
    sheet.addEventListener('click', (event) => {
      if (event.target === sheet || event.target.dataset?.act === 'done') close();
    });
    sheet.addEventListener('input', (event) => {
      const key = event.target.dataset.key;
      if (!key) return;
      const value = event.target.type === 'checkbox' ? event.target.checked : Number(event.target.value);
      settings[key] = value;
      saveSettings();
      const out = sheet.querySelector(`[data-out="${key}"]`);
      if (out) out.textContent = `${value} ${key === 'pageGap' ? 'pt' : 'pt/s'}`;
      this.applySetting(key);
    });
  }

  applySetting(key) {
    switch (key) {
      case 'pageGap': {
        const position = this.currentPosition();
        document.documentElement.style.setProperty('--gap', settings.pageGap + 'px');
        this.measure();
        this.restore(position);
        this.update();
        break;
      }
      case 'showPageNumbers': this.el.classList.toggle('no-numbers', !settings.showPageNumbers); break;
      case 'miniProgress': this.miniEl.hidden = !settings.miniProgress; break;
      case 'warmFilter': this.applyFilters(); break;
      case 'keepAwake':
        if (settings.keepAwake) this.requestWakeLock();
        else { this.wakeLock?.release().catch(() => {}); this.wakeLock = null; }
        break;
    }
  }
}
