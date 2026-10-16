// Document storage behind lib/store.ts and lib/db.ts: Firestore in production, an in-memory copy
// with the same semantics for tests and local runs (NUDGE_STORE=memory).
//
// Values are plain JSON plus Date. `undefined` fields are dropped on write (like the JSON the
// Redis client used to store), so `{ ...existing, field: undefined }` removes `field`.
import { FieldPath, FieldValue, Firestore, Timestamp, type Transaction } from "@google-cloud/firestore";
import { PROJECT_ID } from "@/lib/gcp";

export interface Row<T> {
  id: string;
  data: T;
}

export type Where = [field: string, op: "==" | "<" | "<=" | ">" | ">=", value: unknown];

export interface QueryOpts {
  where?: Where[];
  orderBy?: [field: string, dir: "asc" | "desc"];
  limit?: number;
}

export interface Tx {
  get<T>(path: string): Promise<T | null>;
  set(path: string, data: object): void;
  delete(path: string): void;
}

export interface Backend {
  get<T>(path: string): Promise<T | null>;
  set(path: string, data: object): Promise<void>; // replaces the whole document
  create(path: string, data: object): Promise<boolean>; // false when it already exists
  delete(path: string): Promise<void>;
  add(collection: string, data: object): Promise<string>; // new document with a generated id
  query<T>(collection: string, opts?: QueryOpts): Promise<Row<T>[]>;
  count(collection: string, where?: Where[]): Promise<number>;
  // Map fields with arbitrary keys ("incoming:C1:1700000000.000100"), written without a read
  mapMerge(path: string, field: string, entries: Record<string, unknown>): Promise<void>;
  mapDelete(path: string, field: string, keys: string[]): Promise<void>;
  // Reads first, then writes; retried on contention
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

// Deep copy without undefined (Dates kept)
export function clean<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.filter((v) => v !== undefined).map((v) => clean(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = clean(v);
    return out as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// In memory

const docs = new Map<string, Record<string, unknown>>();
let txChain: Promise<unknown> = Promise.resolve();
let autoId = 0;

export function resetMemoryStore(): void {
  docs.clear();
  autoId = 0;
}

const depth = (path: string) => path.split("/").length;

function compare(a: unknown, b: unknown): number {
  const v = (x: unknown) => (x instanceof Date ? x.getTime() : x);
  const [x, y] = [v(a), v(b)] as [number | string, number | string];
  return x < y ? -1 : x > y ? 1 : 0;
}

function matches(data: Record<string, unknown>, where: Where[] = []): boolean {
  return where.every(([field, op, value]) => {
    const c = compare(data[field], value);
    if (data[field] === undefined) return false;
    return op === "==" ? c === 0 : op === "<" ? c < 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : c >= 0;
  });
}

const memory: Backend = {
  async get<T>(path: string) {
    const d = docs.get(path);
    return d ? (clean(d) as T) : null;
  },
  async set(path, data) {
    docs.set(path, clean(data) as Record<string, unknown>);
  },
  async create(path, data) {
    if (docs.has(path)) return false;
    docs.set(path, clean(data) as Record<string, unknown>);
    return true;
  },
  async delete(path) {
    docs.delete(path);
  },
  async add(collection, data) {
    const id = `m${String(++autoId).padStart(8, "0")}`;
    docs.set(`${collection}/${id}`, clean(data) as Record<string, unknown>);
    return id;
  },
  async query<T>(collection: string, opts: QueryOpts = {}) {
    const prefix = `${collection}/`;
    let rows = [...docs.entries()]
      .filter(([p, d]) => p.startsWith(prefix) && depth(p) === depth(collection) + 1 && matches(d, opts.where))
      .map(([p, d]) => ({ id: p.slice(prefix.length), data: clean(d) as T }));
    if (opts.orderBy) {
      const [field, dir] = opts.orderBy;
      rows = rows
        .filter((r) => (r.data as Record<string, unknown>)[field] !== undefined)
        .sort((a, b) => compare((a.data as Record<string, unknown>)[field], (b.data as Record<string, unknown>)[field]) * (dir === "desc" ? -1 : 1));
    }
    return opts.limit ? rows.slice(0, opts.limit) : rows;
  },
  async count(collection, where) {
    return (await memory.query(collection, { where })).length;
  },
  async mapMerge(path, field, entries) {
    const d = docs.get(path) ?? {};
    d[field] = { ...((d[field] as Record<string, unknown>) ?? {}), ...(clean(entries) as Record<string, unknown>) };
    docs.set(path, d);
  },
  async mapDelete(path, field, keys) {
    const map = docs.get(path)?.[field] as Record<string, unknown> | undefined;
    if (map) for (const k of keys) delete map[k];
  },
  async transaction<T>(fn: (tx: Tx) => Promise<T>) {
    // One at a time, like Firestore's contention retries would end up
    const run = txChain.then(async () => {
      const writes: (() => void)[] = [];
      const result = await fn({
        get: (path) => memory.get(path),
        set: (path, data) => void writes.push(() => docs.set(path, clean(data) as Record<string, unknown>)),
        delete: (path) => void writes.push(() => docs.delete(path)),
      });
      writes.forEach((w) => w());
      return result;
    });
    txChain = run.catch(() => {});
    return run;
  },
};

// ---------------------------------------------------------------------------
// Firestore

let db: Firestore | undefined;
function firestore(): Firestore {
  db ??= new Firestore({
    projectId: PROJECT_ID,
    databaseId: process.env.FIRESTORE_DATABASE || "(default)",
    ignoreUndefinedProperties: true,
  });
  return db;
}

// Timestamps back to Dates, so both backends hand out the same values
function fromFirestore(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate();
  if (Array.isArray(value)) return value.map(fromFirestore);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = fromFirestore(v);
    return out;
  }
  return value;
}

const ALREADY_EXISTS = 6;
const NOT_FOUND = 5;
const code = (err: unknown) => (err as { code?: number })?.code;

const firestoreBackend: Backend = {
  async get<T>(path: string) {
    const snap = await firestore().doc(path).get();
    return snap.exists ? (fromFirestore(snap.data()) as T) : null;
  },
  async set(path, data) {
    await firestore().doc(path).set(clean(data));
  },
  async create(path, data) {
    try {
      await firestore().doc(path).create(clean(data));
      return true;
    } catch (err) {
      if (code(err) === ALREADY_EXISTS) return false;
      throw err;
    }
  },
  async delete(path) {
    await firestore().doc(path).delete();
  },
  async add(collection, data) {
    return (await firestore().collection(collection).add(clean(data))).id;
  },
  async query<T>(collection: string, opts: QueryOpts = {}) {
    let q: FirebaseFirestore.Query = firestore().collection(collection);
    for (const [field, op, value] of opts.where ?? []) q = q.where(field, op, value);
    if (opts.orderBy) q = q.orderBy(opts.orderBy[0], opts.orderBy[1]);
    if (opts.limit) q = q.limit(opts.limit);
    const snap = await q.get();
    return snap.docs.map((d) => ({ id: d.id, data: fromFirestore(d.data()) as T }));
  },
  async count(collection, where = []) {
    let q: FirebaseFirestore.Query = firestore().collection(collection);
    for (const [field, op, value] of where) q = q.where(field, op, value);
    return (await q.count().get()).data().count;
  },
  async mapMerge(path, field, entries) {
    await firestore().doc(path).set({ [field]: clean(entries) }, { merge: true });
  },
  async mapDelete(path, field, keys) {
    const ref = firestore().doc(path);
    for (let i = 0; i < keys.length; i += 400) {
      const pairs: unknown[] = keys.slice(i, i + 400).flatMap((k) => [new FieldPath(field, k), FieldValue.delete()]);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (ref.update as any)(...pairs);
      } catch (err) {
        if (code(err) === NOT_FOUND) return;
        throw err;
      }
    }
  },
  async transaction<T>(fn: (tx: Tx) => Promise<T>) {
    return firestore().runTransaction(async (t: Transaction) =>
      fn({
        get: async (path) => {
          const snap = await t.get(firestore().doc(path));
          return snap.exists ? (fromFirestore(snap.data()) as never) : null;
        },
        set: (path, data) => void t.set(firestore().doc(path), clean(data)),
        delete: (path) => void t.delete(firestore().doc(path)),
      })
    );
  },
};

export const backend: Backend = process.env.NUDGE_STORE === "memory" ? memory : firestoreBackend;
