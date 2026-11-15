// Persistent browser cache (IndexedDB) for user-written blank & saved .TRD disk images

export interface SavedDiskMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionDiskHistoryItem {
  id: string;
  name: string;
  bytes: Uint8Array;
}

export function upsertSessionDiskHistory(
  prev: readonly SessionDiskHistoryItem[],
  name: string,
  bytes: Uint8Array
): SessionDiskHistoryItem[] {
  const existing = prev.find((item) => item.name === name);
  const nextItem: SessionDiskHistoryItem = {
    id: existing?.id ?? `${name}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
    name,
    bytes,
  };
  return [nextItem, ...prev.filter((item) => item.name !== name)];
}

interface SavedDiskRecord extends SavedDiskMeta {
  bytes: Uint8Array;
}

const DB_NAME = 'zx_spectrum_disks_db';
const DB_VERSION = 1;
const STORE_NAME = 'saved_disks';

// In-memory fallback for environments without IndexedDB (e.g. restricted private contexts)
const memoryFallback = new Map<string, SavedDiskRecord>();

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDiskDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

function toMeta(rec: SavedDiskRecord): SavedDiskMeta {
  return {
    id: rec.id,
    name: rec.name,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

export function normalizeDiskFilename(raw: string): string {
  const trimmed = raw.trim().replace(/[\\/:*?"<>|]/g, '_');
  const base = trimmed.length > 0 ? trimmed : 'Диск';
  return base.toLowerCase().endsWith('.trd') ? base : `${base}.trd`;
}

export function generateNextDiskName(existing: readonly SavedDiskMeta[]): string {
  const used = new Set(existing.map((d) => d.name.toLowerCase()));
  let n = 1;
  while (used.has(`диск ${n}.trd`)) {
    n++;
  }
  return `Диск ${n}.trd`;
}

export async function listSavedDisks(): Promise<SavedDiskMeta[]> {
  const db = await openDiskDb();
  if (!db) {
    return Array.from(memoryFallback.values())
      .map(toMeta)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = (req.result as SavedDiskRecord[] | undefined) ?? [];
        const metas = rows.map(toMeta).sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(metas);
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function getSavedDiskBytes(id: string): Promise<Uint8Array | null> {
  const db = await openDiskDb();
  if (!db) {
    const rec = memoryFallback.get(id);
    return rec ? rec.bytes.slice() : null;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => {
        const rec = req.result as SavedDiskRecord | undefined;
        if (!rec?.bytes) {
          resolve(null);
          return;
        }
        resolve(rec.bytes instanceof Uint8Array ? rec.bytes.slice() : new Uint8Array(rec.bytes));
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function putSavedDisk(
  id: string,
  name: string,
  bytes: Uint8Array,
  createdAt?: number
): Promise<SavedDiskMeta> {
  const now = Date.now();
  const record: SavedDiskRecord = {
    id,
    name: normalizeDiskFilename(name),
    createdAt: createdAt ?? now,
    updatedAt: now,
    bytes: bytes.slice(),
  };

  const db = await openDiskDb();
  if (!db) {
    memoryFallback.set(id, record);
    return toMeta(record);
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve(toMeta(record));
      tx.onerror = () => {
        memoryFallback.set(id, record);
        resolve(toMeta(record));
      };
    } catch {
      memoryFallback.set(id, record);
      resolve(toMeta(record));
    }
  });
}

export async function renameSavedDisk(id: string, newName: string): Promise<SavedDiskMeta | null> {
  const normalized = normalizeDiskFilename(newName);
  const db = await openDiskDb();
  if (!db) {
    const existing = memoryFallback.get(id);
    if (!existing) return null;
    const updated: SavedDiskRecord = { ...existing, name: normalized, updatedAt: Date.now() };
    memoryFallback.set(id, updated);
    return toMeta(updated);
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(id);
      let updatedMeta: SavedDiskMeta | null = null;
      getReq.onsuccess = () => {
        const rec = getReq.result as SavedDiskRecord | undefined;
        if (!rec) return;
        const next: SavedDiskRecord = {
          ...rec,
          name: normalized,
          updatedAt: Date.now(),
        };
        updatedMeta = toMeta(next);
        store.put(next);
      };
      tx.oncomplete = () => resolve(updatedMeta);
      tx.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function deleteSavedDisk(id: string): Promise<void> {
  memoryFallback.delete(id);
  const db = await openDiskDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export function triggerDiskDownload(filename: string, bytes: Uint8Array): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const normalized = normalizeDiskFilename(filename);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = normalized;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
