export interface QueuedOfflineEntry {
  entryDate: string;
  content: string;
  expectedUpdatedAt: string | null;
  queuedAt: string;
}

export interface OfflineEntryQueueStore {
  put(item: QueuedOfflineEntry): Promise<void>;
  get(entryDate: string): Promise<QueuedOfflineEntry | null>;
  remove(entryDate: string): Promise<void>;
  listAll(): Promise<QueuedOfflineEntry[]>;
}

const DB_NAME = 'firstwrite-offline-db';
const DB_VERSION = 1;
const STORE_NAME = 'pending_entries';

/**
 * In-memory fallback store used when `indexedDB` is unavailable (e.g. restricted browsing contexts or unit tests)
 * and backed by IndexedDB in all standard modern browsers.
 */
export class InMemoryOfflineQueueStore implements OfflineEntryQueueStore {
  private readonly items = new Map<string, QueuedOfflineEntry>();

  public async put(item: QueuedOfflineEntry): Promise<void> {
    this.items.set(item.entryDate, { ...item });
  }

  public async get(entryDate: string): Promise<QueuedOfflineEntry | null> {
    const found = this.items.get(entryDate);
    return found ? { ...found } : null;
  }

  public async remove(entryDate: string): Promise<void> {
    this.items.delete(entryDate);
  }

  public async listAll(): Promise<QueuedOfflineEntry[]> {
    return Array.from(this.items.values())
      .map((item) => ({ ...item }))
      .sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0));
  }
}

function openOfflineIndexedDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'entryDate' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });
}

/**
 * Creates an IndexedDB-backed `OfflineEntryQueueStore` with automatic fallback to `InMemoryOfflineQueueStore`
 * if `indexedDB` is unavailable.
 */
export function createBrowserOfflineQueueStore(): OfflineEntryQueueStore {
  const memoryFallback = new InMemoryOfflineQueueStore();

  function hasIndexedDb(): boolean {
    return typeof globalThis !== 'undefined' && typeof globalThis.indexedDB !== 'undefined';
  }

  return {
    async put(item: QueuedOfflineEntry): Promise<void> {
      await memoryFallback.put(item);
      if (!hasIndexedDb()) return;
      try {
        const db = await openOfflineIndexedDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).put(item);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error ?? new Error('IndexedDB put failed'));
          };
        });
      } catch {
        // Keep in memoryFallback on IDB quota/permission error
      }
    },

    async get(entryDate: string): Promise<QueuedOfflineEntry | null> {
      if (!hasIndexedDb()) {
        return memoryFallback.get(entryDate);
      }
      try {
        const db = await openOfflineIndexedDb();
        return await new Promise<QueuedOfflineEntry | null>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const req = tx.objectStore(STORE_NAME).get(entryDate);
          req.onsuccess = () => {
            db.close();
            const res = req.result as QueuedOfflineEntry | undefined;
            resolve(res ?? null);
          };
          req.onerror = () => {
            db.close();
            reject(req.error ?? new Error('IndexedDB get failed'));
          };
        });
      } catch {
        return memoryFallback.get(entryDate);
      }
    },

    async remove(entryDate: string): Promise<void> {
      await memoryFallback.remove(entryDate);
      if (!hasIndexedDb()) return;
      try {
        const db = await openOfflineIndexedDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).delete(entryDate);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error ?? new Error('IndexedDB delete failed'));
          };
        });
      } catch {
        // Ignore IDB delete error
      }
    },

    async listAll(): Promise<QueuedOfflineEntry[]> {
      if (!hasIndexedDb()) {
        return memoryFallback.listAll();
      }
      try {
        const db = await openOfflineIndexedDb();
        return await new Promise<QueuedOfflineEntry[]>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const req = tx.objectStore(STORE_NAME).getAll();
          req.onsuccess = () => {
            db.close();
            const list = (req.result as QueuedOfflineEntry[] | undefined) ?? [];
            resolve(
              list.sort((a, b) =>
                a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0,
              ),
            );
          };
          req.onerror = () => {
            db.close();
            reject(req.error ?? new Error('IndexedDB getAll failed'));
          };
        });
      } catch {
        return memoryFallback.listAll();
      }
    },
  };
}
