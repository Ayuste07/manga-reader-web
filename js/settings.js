// Ajustes y progreso de lectura en localStorage (síncrono → se guarda aunque cierres de golpe).
const SETTINGS_KEY = 'manga.settings';

const DEFAULTS = {
  pageGap: 14,
  showPageNumbers: true,
  miniProgress: true,
  tapZones: true,
  autoScrollSpeed: 70,
  keepAwake: true,
  warmFilter: false,
  dimming: 0,
};

function read(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* modo privado / lleno */ }
}

export const settings = { ...DEFAULTS, ...(read(SETTINGS_KEY) || {}) };

export function saveSettings() { write(SETTINGS_KEY, settings); }

/** @returns {{pageIndex:number, offsetInPage:number, currentPage:number, at:number} | null} */
export function getProgress(id) { return read('manga.progress.' + id); }

export function setProgress(id, position) { write('manga.progress.' + id, { ...position, at: Date.now() }); }

export function clearProgress(id) {
  try { localStorage.removeItem('manga.progress.' + id); } catch { /* ignore */ }
}
