import { readSaveHeader, SAVE_EXT, SAVE_MIME } from './format.js';

// Saves kept in the browser (IndexedDB), and saves as files. Garry's Mod keeps
// a save as the file plus a screenshot beside it, listed with that thumbnail
// in its menu's Saves; TPT keeps local saves in a folder its Open button
// lists with Ctrl held (GameView.cpp searchButton, GameController.cpp
// OpenLocalBrowse). Here two object stores: `meta` (what the Saves list
// shows: name, date, map, size, thumbnail) and `data` (the file's bytes), so
// listing never reads the bytes.
//
// Plain module (no three.js): the start menu lists saves before the game loads.

const DB_NAME = 'powder-toy-3d:saves';
const DB_VERSION = 1;
const META = 'meta', DATA = 'data';
const NAME_MAX = 60;           // characters of a save's name
const FILE_NAME_MAX = 40;      // characters of the name in a file's name

let opening = null;
function db() {
  return (opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(DATA)) d.createObjectStore(DATA);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { opening = null; reject(req.error); };
  }));
}

const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const finished = (tx) => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); });

export const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

// what the list shows of a save, from its header
const metaOf = (id, h, bytes) => ({
  id, name: cleanName(h.name) || 'Untitled', created: h.created, map: h.map ?? null, mapName: h.mapName ?? null,
  dims: h.dims, world: !!h.world, thumbnail: h.thumbnail ?? null, bytes,
});

// Every local save's meta, newest first.
export async function listSaves() {
  const tx = (await db()).transaction(META);
  const all = await done(tx.objectStore(META).getAll());
  return all.sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

// Keep a save's bytes (from encodeSave); a new id unless one is given (overwrite). Returns its meta.
export async function putSave(bytes, id = null) {
  const h = readSaveHeader(bytes);
  const key = id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const meta = metaOf(key, h, bytes.length);
  const tx = (await db()).transaction([META, DATA], 'readwrite');
  tx.objectStore(META).put(meta);
  tx.objectStore(DATA).put(bytes, key);
  await finished(tx);
  return meta;
}

export async function getSave(id) {
  const tx = (await db()).transaction(DATA);
  const bytes = await done(tx.objectStore(DATA).get(id));
  if (!bytes) throw new Error('that save is gone');
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

export async function deleteSave(id) {
  const tx = (await db()).transaction([META, DATA], 'readwrite');
  tx.objectStore(META).delete(id);
  tx.objectStore(DATA).delete(id);
  await finished(tx);
}

export async function renameSave(id, name) {
  const tx = (await db()).transaction(META, 'readwrite');
  const store = tx.objectStore(META);
  const meta = await done(store.get(id));
  if (meta) store.put({ ...meta, name: cleanName(name) || meta.name });
  await finished(tx);
}

// ---- files ----

// a file name for a save: its name, made safe, and the extension
export function fileName(name) {
  const base = cleanName(name).replace(/[^\w\- ]+/g, '').trim().replace(/ +/g, '-').slice(0, FILE_NAME_MAX) || 'save';
  return `${base}${SAVE_EXT}`;
}

// Download a save's bytes as a file.
export function downloadSave(bytes, name) {
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([bytes], { type: SAVE_MIME })),
    download: fileName(name),
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Ask for a save file; resolves to its bytes, or null if none was picked.
export function pickSaveFile() {
  return new Promise((resolve, reject) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: `${SAVE_EXT},${SAVE_MIME}` });
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (!f) { resolve(null); return; }
      f.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject);
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}
