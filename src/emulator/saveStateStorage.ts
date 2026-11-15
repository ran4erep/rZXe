// Persistent browser cache (IndexedDB) for ZX Spectrum .SNA savestates with screenshots

import { MachineId, getMachineProfile } from './machines';

export interface SaveStateMeta {
  id: string;
  title: string;
  gameKey?: string;
  machineId: MachineId;
  createdAt: number;
  screenshotDataUrl: string;
}

export interface SaveStateRecord extends SaveStateMeta {
  snaBytes: Uint8Array;
}

const DB_NAME = 'zx_spectrum_savestates_db';
const DB_VERSION = 1;
const STORE_NAME = 'savestates';

// Fallback store when IndexedDB is unavailable (Node tests / restricted contexts)
const memoryFallback = new Map<string, SaveStateRecord>();

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openSaveStateDb(): Promise<IDBDatabase | null> {
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

function toMeta(rec: SaveStateRecord): SaveStateMeta {
  return {
    id: rec.id,
    title: rec.title,
    gameKey: rec.gameKey,
    machineId: rec.machineId,
    createdAt: rec.createdAt,
    screenshotDataUrl: rec.screenshotDataUrl,
  };
}

export function resolveSaveStateGameKey(
  activeGameTitle: string | null | undefined,
  driveADiskName: string | null | undefined,
  machineId: MachineId,
  explicitGameKey?: string | null
): string {
  const explicit = explicitGameKey?.trim();
  if (explicit && explicit.length > 0) {
    return explicit.toLowerCase();
  }
  const raw = activeGameTitle?.trim() || driveADiskName?.trim() || '';
  if (raw.length > 0) {
    return `game:${raw.toLowerCase()}`;
  }
  return `bios:${machineId}`;
}

export function getSaveStateGameKey(
  meta: Pick<SaveStateMeta, 'gameKey' | 'title' | 'machineId'>
): string {
  if (meta.gameKey && meta.gameKey.trim().length > 0) {
    return meta.gameKey.trim().toLowerCase();
  }
  const machineName = getMachineProfile(meta.machineId).name;
  const trimmedTitle = meta.title.trim();
  if (!trimmedTitle || trimmedTitle === machineName) {
    return `bios:${meta.machineId}`;
  }
  return `game:${trimmedTitle.toLowerCase()}`;
}

export function extractZxArtProdIdFromKey(gameKey: string | null | undefined): number | null {
  if (!gameKey) return null;
  const match = /^zxart:(\d+)(?::rel:\d+)?$/i.exec(gameKey.trim());
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) ? id : null;
}

export function isReleaseScopedGameKey(gameKey: string | null | undefined): boolean {
  if (!gameKey) return false;
  return /^zxart:\d+:rel:\d+$/i.test(gameKey.trim());
}

export function doesSaveStateMatchGame(
  meta: Pick<SaveStateMeta, 'gameKey' | 'title' | 'machineId'>,
  target: {
    gameKey?: string | null;
    title?: string | null;
    machineId?: MachineId;
  }
): boolean {
  const metaKey = getSaveStateGameKey(meta);
  const targetKey = target.gameKey?.trim().toLowerCase() || '';
  const targetTitleLower = target.title?.trim().toLowerCase() || '';

  if (targetKey) {
    // Release-scoped key (zxart:<prodId>:rel:<releaseId>) must match ONLY that exact version
    if (isReleaseScopedGameKey(targetKey)) {
      return metaKey === targetKey;
    }

    if (metaKey === targetKey) return true;

    // Product-level zxart:<prodId> key aggregates all releases of that product + legacy title saves
    const prodId = extractZxArtProdIdFromKey(targetKey);
    if (prodId !== null) {
      if (metaKey.startsWith(`zxart:${prodId}:rel:`)) return true;
      if (targetTitleLower && metaKey === `game:${targetTitleLower}`) return true;
      return false;
    }

    if (targetTitleLower && metaKey === `game:${targetTitleLower}`) return true;
    if (
      targetKey.startsWith('game:') &&
      !metaKey.startsWith('bios:') &&
      !isReleaseScopedGameKey(metaKey) &&
      targetTitleLower.length > 0 &&
      meta.title.trim().toLowerCase() === targetTitleLower
    ) {
      return true;
    }
    return false;
  }

  if (targetTitleLower) {
    if (metaKey === `game:${targetTitleLower}`) return true;
    if (
      metaKey.startsWith('zxart:') &&
      !isReleaseScopedGameKey(metaKey) &&
      meta.title.trim().toLowerCase() === targetTitleLower
    ) {
      return true;
    }
    return false;
  }

  if (target.machineId) {
    return metaKey === `bios:${target.machineId}`;
  }

  return false;
}

export function normalizeSnaFilename(rawTitle: string): string {
  const trimmed = rawTitle.trim().replace(/[\\/:*?"<>|]/g, '_');
  const base = trimmed.length > 0 ? trimmed : 'savestate';
  return base.toLowerCase().endsWith('.sna') ? base : `${base}.sna`;
}

export function triggerSaveStateDownload(title: string, snaBytes: Uint8Array): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const filename = normalizeSnaFilename(title);
  const copy = new Uint8Array(snaBytes.byteLength);
  copy.set(snaBytes);
  const blob = new Blob([copy.buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function listSaveStates(): Promise<SaveStateMeta[]> {
  const db = await openSaveStateDb();
  if (!db) {
    return Array.from(memoryFallback.values())
      .map(toMeta)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        const rows = (req.result as SaveStateRecord[] | undefined) ?? [];
        const metas = rows.map(toMeta).sort((a, b) => b.createdAt - a.createdAt);
        resolve(metas);
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function putSaveState(params: {
  id: string;
  title: string;
  gameKey?: string;
  machineId: MachineId;
  createdAt?: number;
  screenshotDataUrl: string;
  snaBytes: Uint8Array;
}): Promise<SaveStateMeta> {
  const record: SaveStateRecord = {
    id: params.id,
    title: params.title.trim() || 'Снимок памяти',
    gameKey: params.gameKey,
    machineId: params.machineId,
    createdAt: params.createdAt ?? Date.now(),
    screenshotDataUrl: params.screenshotDataUrl,
    snaBytes: params.snaBytes.slice(),
  };

  const db = await openSaveStateDb();
  if (!db) {
    memoryFallback.set(record.id, record);
    return toMeta(record);
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve(toMeta(record));
      tx.onerror = () => {
        memoryFallback.set(record.id, record);
        resolve(toMeta(record));
      };
    } catch {
      memoryFallback.set(record.id, record);
      resolve(toMeta(record));
    }
  });
}

export async function getSaveStateRecord(id: string): Promise<SaveStateRecord | null> {
  const db = await openSaveStateDb();
  if (!db) {
    const rec = memoryFallback.get(id);
    return rec ? { ...rec, snaBytes: rec.snaBytes.slice() } : null;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => {
        const rec = req.result as SaveStateRecord | undefined;
        if (!rec?.snaBytes) {
          resolve(null);
          return;
        }
        resolve({
          ...toMeta(rec),
          snaBytes: rec.snaBytes instanceof Uint8Array ? rec.snaBytes.slice() : new Uint8Array(rec.snaBytes),
        });
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function deleteSaveState(id: string): Promise<void> {
  const db = await openSaveStateDb();
  if (!db) {
    memoryFallback.delete(id);
    return;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        memoryFallback.delete(id);
        resolve();
      };
    } catch {
      memoryFallback.delete(id);
      resolve();
    }
  });
}
