// IndexedDB: los PDFs se guardan como Blob en el propio iPhone (no se suben a ningún sitio).
const DB_NAME = 'manga-reader';
const STORES = ['items', 'files', 'thumbs'];
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('items', { keyPath: 'id' });
      db.createObjectStore('files');
      db.createObjectStore('thumbs');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

const promisify = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function store(name, mode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}

export const db = {
  async allItems() { return promisify((await store('items')).getAll()); },
  async putItem(item) { return promisify((await store('items', 'readwrite')).put(item)); },
  async getFile(id) { return promisify((await store('files')).get(id)); },
  async getThumb(id) { return promisify((await store('thumbs')).get(id)); },

  /** Guarda PDF + portada + ficha en una sola transacción. */
  async add(item, file, thumb) {
    const tx = (await open()).transaction(STORES, 'readwrite');
    tx.objectStore('files').put(file, item.id);
    if (thumb) tx.objectStore('thumbs').put(thumb, item.id);
    tx.objectStore('items').put(item);
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },

  async remove(id) {
    const tx = (await open()).transaction(STORES, 'readwrite');
    STORES.forEach((name) => tx.objectStore(name).delete(id));
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  },
};
