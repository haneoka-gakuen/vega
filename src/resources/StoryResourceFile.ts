/** Encoded resource payload; independent of decoded images and GPU objects. */
export interface StoryResourceFile {
  read(): Promise<Blob | undefined>;
  release(): void;
}

const DATABASE = "vega.resource.files";
const STORE = "files";
const OPEN_TIMEOUT = 2_000;
const TRANSACTION_TIMEOUT = 5_000;
const STALE_AFTER = 7 * 24 * 60 * 60 * 1_000;
let database: Promise<IDBDatabase | undefined> | undefined;
let writesUnavailable = false;
let storeBuffers = false;

interface ResourceRecord {
  readonly blob?: Blob;
  readonly bytes?: ArrayBuffer;
  readonly type?: string;
}

const openDatabase = (): Promise<IDBDatabase | undefined> => {
  database ??= new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(undefined);
    let finished = false;
    const finish = (value?: IDBDatabase): void => {
      if (finished) {
        value?.close();
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(), OPEN_TIMEOUT);
    try {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { autoIncrement: true });
        store.createIndex("created", "created");
      };
      request.onerror = () => finish();
      request.onblocked = () => finish();
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          database = undefined;
        };
        if (!finished) {
          // Recover storage left behind by a terminated browser process.
          const transaction = db.transaction(STORE, "readwrite");
          const cursor = transaction
            .objectStore(STORE)
            .index("created")
            .openCursor(IDBKeyRange.upperBound(Date.now() - STALE_AFTER));
          cursor.onsuccess = () => {
            if (!cursor.result) return;
            cursor.result.delete();
            cursor.result.continue();
          };
        }
        finish(db);
      };
    } catch {
      finish();
    }
  });
  return database;
};

const transact = <T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> =>
  new Promise((resolve, reject) => {
    let transaction: IDBTransaction | undefined;
    const timer = setTimeout(() => {
      try {
        transaction?.abort();
      } catch {
        /* Already completed. */
      }
      reject(new Error("Story resource storage timed out"));
    }, TRANSACTION_TIMEOUT);
    try {
      transaction = db.transaction(STORE, mode);
      const request = operation(transaction.objectStore(STORE));
      transaction.oncomplete = () => {
        clearTimeout(timer);
        resolve(request.result);
      };
      transaction.onabort = transaction.onerror = () => {
        clearTimeout(timer);
        reject(transaction?.error ?? request.error ?? new Error("Story resource storage failed"));
      };
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });

/** Prefer disk-backed files; restricted/quota-limited hosts keep encoded Blobs. */
export const storeStoryResourceFile = async (blob: Blob): Promise<StoryResourceFile> => {
  const db = writesUnavailable ? undefined : await openDatabase();
  if (db) {
    try {
      let key: IDBValidKey;
      const addBinary = async (): Promise<IDBValidKey> => {
        const bytes = await blob.arrayBuffer();
        return transact(db, "readwrite", (store) => store.add({ bytes, type: blob.type, created: Date.now() }));
      };
      if (storeBuffers) key = await addBinary();
      else {
        try {
          key = await transact(db, "readwrite", (store) => store.add({ blob, created: Date.now() }));
        } catch (error) {
          if (error instanceof DOMException && error.name === "QuotaExceededError") throw error;
          // Some WebKit hosts expose IndexedDB but reject Blob serialization.
          // Binary records retain disk storage without relying on that feature.
          key = await addBinary();
          storeBuffers = true;
        }
      }
      let released = false;
      return {
        async read() {
          if (released) return undefined;
          const record = await transact<ResourceRecord | undefined>(db, "readonly", (store) => store.get(key));
          if (released || !record) return undefined;
          return record.blob ?? (record.bytes ? new Blob([record.bytes], { type: record.type }) : undefined);
        },
        release() {
          if (released) return;
          released = true;
          void transact(db, "readwrite", (store) => store.delete(key)).catch(() => undefined);
        },
      };
    } catch {
      // Preserve the payload when storage is denied or full. Decoded/GPU
      // resources still follow their normal lifetime and memory budgets.
      writesUnavailable = true;
    }
  }
  let payload: Blob | undefined = blob;
  return {
    read: async () => payload,
    release: () => {
      payload = undefined;
    },
  };
};
