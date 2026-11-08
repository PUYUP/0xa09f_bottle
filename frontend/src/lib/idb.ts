const DB_NAME = "a09f";
const DB_VERSION = 1;
const KEY_STORE = "keys";
const META_STORE = "meta";

let db: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(KEY_STORE)) d.createObjectStore(KEY_STORE, { keyPath: "kid" });
      if (!d.objectStoreNames.contains(META_STORE)) d.createObjectStore(META_STORE, { keyPath: "id" });
    };
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => {
        d.close();
        if (db === d) db = null;
      };
      d.onclose = () => {
        if (db === d) db = null;
      };
      resolve(d);
    };
    req.onerror = () => reject(req.error);
  });
}

async function ensureDB(): Promise<IDBDatabase> {
  if (!db) db = await openDB();
  return db;
}

export async function idbGetAll<T>(storeName: string): Promise<T[]> {
  const d = await ensureDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, "readonly");
    const req = t.objectStore(storeName).getAll();
    req.onsuccess = () => resolve((req.result || []) as T[]);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet<T>(storeName: string, key: string): Promise<T | undefined> {
  const d = await ensureDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, "readonly");
    const req = t.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function idbDelete(storeName: string, key: string): Promise<void> {
  const d = await ensureDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, "readwrite");
    const req = t.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    t.onabort = () => reject(t.error);
  });
}

export async function idbClear(storeName: string): Promise<void> {
  const d = await ensureDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, "readwrite");
    const req = t.objectStore(storeName).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    t.onabort = () => reject(t.error);
  });
}

export async function idbPut<T>(storeName: string, value: T, key?: string): Promise<unknown> {
  const d = await ensureDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, "readwrite");
    const s = t.objectStore(storeName);
    let result: unknown;
    const req = key === undefined ? s.put(value as object) : s.put(value as object, key);
    req.onsuccess = () => {
      result = req.result;
    };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export { KEY_STORE, META_STORE };
