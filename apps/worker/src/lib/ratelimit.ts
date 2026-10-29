export type RateLimitResult = { allowed: boolean; remaining: number };

export async function consumeRateLimit(
  kv: KVNamespace,
  bucket: string,
  limit: number,
  windowSeconds: number,
  nowMs = Date.now(),
): Promise<RateLimitResult> {
  const windowIndex = Math.floor(nowMs / 1000 / windowSeconds);
  const key = `rl:${bucket}:${String(windowIndex)}`;
  const current = Number.parseInt((await kv.get(key)) ?? "0", 10) || 0;
  if (current >= limit) return { allowed: false, remaining: 0 };
  await kv.put(key, String(current + 1), { expirationTtl: Math.max(60, windowSeconds * 2) });
  return { allowed: true, remaining: limit - current - 1 };
}
