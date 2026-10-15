// Offline-first IndexedDB wrapper. ~30 lines, promise-based, no library.
// Stores: reminders | gait | screening | meta | events | conversation.
// Records use an `id` key.

export type Store = "reminders" | "gait" | "screening" | "meta" | "events" | "conversation";

const DB_NAME = "auragba";
// v3 adds the `conversation` store (local conversation memory the backend agent
// reads to derive reminders). onupgradeneeded creates only missing stores, so
// existing users migrate in place.
const DB_VERSION = 3;
const STORES: Store[] = ["reminders", "gait", "screening", "meta", "events", "conversation"];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(store, mode).objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

export function put<T extends { id: string }>(store: Store, value: T): Promise<IDBValidKey> {
  return tx(store, "readwrite", (s) => s.put(value));
}

export function all<T>(store: Store): Promise<T[]> {
  return tx<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>);
}

export function get<T>(store: Store, key: string): Promise<T | undefined> {
  return tx<T | undefined>(store, "readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
}

export function del(store: Store, key: string): Promise<void> {
  return tx(store, "readwrite", (s) => s.delete(key) as unknown as IDBRequest<void>);
}