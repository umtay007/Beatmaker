/**
 * The user's own sounds (drum packs, samples for the sampler), kept in this browser with
 * IndexedDB so they survive reloads. Nothing is uploaded anywhere. When IndexedDB is unavailable
 * (private windows, blocked storage) everything still works for the session, in memory.
 */

export interface StoredFile {
  id: string;
  name: string;
  data: ArrayBuffer;
}

export interface UserKit {
  id: string;
  name: string;
  /** GM drum pitch → stored file id. */
  files: Record<number, string>;
  created: number;
}

const DB_NAME = 'beatmaker-library';
const STORES = ['files', 'kits'] as const;
type StoreName = (typeof STORES)[number];

let dbp: Promise<IDBDatabase | null> | null = null;
const memory: Record<StoreName, Map<string, unknown>> = { files: new Map(), kits: new Map() };

function open(): Promise<IDBDatabase | null> {
  dbp ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

function run<T>(store: StoreName, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) return resolve(undefined);
        try {
          const req = op(db.transaction(store, mode).objectStore(store));
          req.onsuccess = () => resolve(req.result as T);
          req.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

/** Save to IndexedDB, or keep it in memory for the session when that fails. */
async function put(store: StoreName, value: { id: string }): Promise<void> {
  const key = await run<IDBValidKey>(store, 'readwrite', (s) => s.put(value));
  if (key === undefined) memory[store].set(value.id, value);
}

async function get<T>(store: StoreName, id: string): Promise<T | undefined> {
  return (memory[store].get(id) as T | undefined) ?? (await run<T>(store, 'readonly', (s) => s.get(id)));
}

async function all<T>(store: StoreName): Promise<T[]> {
  const stored = (await run<T[]>(store, 'readonly', (s) => s.getAll())) ?? [];
  const byId = new Map<string, T>(stored.map((v) => [(v as { id: string }).id, v]));
  for (const [id, v] of memory[store]) byId.set(id, v as T);
  return [...byId.values()];
}

async function del(store: StoreName, id: string): Promise<void> {
  memory[store].delete(id);
  await run(store, 'readwrite', (s) => s.delete(id));
}

const rid = (p: string) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export async function putFile(name: string, data: ArrayBuffer): Promise<string> {
  const id = rid('f');
  const file: StoredFile = { id, name, data };
  await put('files', file);
  return id;
}

/** Store a sound under a known id (restoring a project bundle); a sound already there is kept. */
export async function putFileWithId(id: string, name: string, data: ArrayBuffer): Promise<void> {
  if (await get<StoredFile>('files', id)) return;
  const file: StoredFile = { id, name, data };
  await put('files', file);
}

export function getStoredFile(id: string): Promise<StoredFile | undefined> {
  return get<StoredFile>('files', id);
}

/** A sound's bytes: always a fresh copy (decodeAudioData detaches the buffer it is given). */
export async function getFile(id: string): Promise<ArrayBuffer> {
  const f = await get<StoredFile>('files', id);
  if (!f) throw new Error('That sound is not in this browser any more');
  return memory.files.has(id) ? f.data.slice(0) : f.data;
}

export function listKits(): Promise<UserKit[]> {
  return all<UserKit>('kits').then((k) => k.sort((a, b) => a.created - b.created));
}

export async function saveKit(name: string, files: Record<number, string>): Promise<UserKit> {
  const kit: UserKit = { id: rid('u'), name, files, created: Date.now() };
  await put('kits', kit);
  return kit;
}

export function getKit(id: string): Promise<UserKit | undefined> {
  return get<UserKit>('kits', id);
}

/** Save a pack under its own id (restoring a project bundle). */
export async function putKit(kit: UserKit): Promise<void> {
  await put('kits', kit);
}

/** Delete a pack and the sounds only it used. */
export async function deleteKit(id: string): Promise<void> {
  const kits = await listKits();
  const gone = kits.find((k) => k.id === id);
  await del('kits', id);
  if (!gone) return;
  const used = new Set(kits.filter((k) => k.id !== id).flatMap((k) => Object.values(k.files)));
  for (const f of Object.values(gone.files)) if (!used.has(f)) await del('files', f);
}

/** Whether sounds persist across reloads here (false: they last for this session only). */
export async function persistent(): Promise<boolean> {
  return (await open()) !== null;
}
