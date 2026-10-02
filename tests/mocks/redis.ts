// In-memory stand-in for the subset of @upstash/redis the app uses.
// Values round-trip through JSON like the real client (undefined fields disappear).

type Json = unknown;

const strings = new Map<string, string>();
const sets = new Map<string, Set<string>>();
const zsets = new Map<string, Map<string, number>>();

export function resetRedis(): void {
  strings.clear();
  sets.clear();
  zsets.clear();
}

const clone = (v: Json) => JSON.stringify(v);
const parse = <T>(v: string | undefined): T | null => (v === undefined ? null : (JSON.parse(v) as T));
const zset = (key: string) => {
  if (!zsets.has(key)) zsets.set(key, new Map());
  return zsets.get(key)!;
};
const inRange = (score: number, min: number | string, max: number | string) =>
  score >= (min === "-inf" ? -Infinity : Number(min)) && score <= (max === "+inf" ? Infinity : Number(max));

export class Redis {
  static fromEnv(): Redis {
    return new Redis();
  }

  async set(key: string, value: Json, opts?: { nx?: boolean; ex?: number }): Promise<"OK" | null> {
    if (opts?.nx && strings.has(key)) return null;
    strings.set(key, clone(value));
    return "OK";
  }

  async get<T>(key: string): Promise<T | null> {
    return parse<T>(strings.get(key));
  }

  async mget<T>(...keys: string[]): Promise<T> {
    return keys.map((k) => parse(strings.get(k))) as T;
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) n += Number(strings.delete(k) || sets.delete(k) || zsets.delete(k));
    return n;
  }

  async exists(key: string): Promise<number> {
    return strings.has(key) || sets.has(key) || zsets.has(key) ? 1 : 0;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    if (!sets.has(key)) sets.set(key, new Set());
    members.forEach((m) => sets.get(key)!.add(m));
    return members.length;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    members.forEach((m) => sets.get(key)?.delete(m));
    return members.length;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(sets.get(key) ?? [])];
  }

  async zadd(key: string, ...entries: { score: number; member: string }[]): Promise<number> {
    entries.forEach((e) => zset(key).set(e.member, e.score));
    return entries.length;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    members.forEach((m) => zsets.get(key)?.delete(m));
    return members.length;
  }

  async zrange<T>(key: string, start: number, stop: number): Promise<T> {
    const sorted = [...(zsets.get(key) ?? new Map()).entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0]);
    return sorted.slice(start, stop === -1 ? undefined : stop + 1) as T;
  }

  async zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number> {
    const z = zsets.get(key);
    if (!z) return 0;
    let n = 0;
    for (const [m, s] of z) if (inRange(s, min, max)) n += Number(z.delete(m));
    return n;
  }

  async zcount(key: string, min: number | string, max: number | string): Promise<number> {
    return [...(zsets.get(key)?.values() ?? [])].filter((s) => inRange(s, min, max)).length;
  }
}
