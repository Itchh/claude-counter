// A stable bucket for a string key.
//
// FNV-1a, 32-bit: small, deterministic, and spreads a handful of buckets
// evenly enough. Used wherever a driver's key has to pick one of N things —
// a chassis, an airframe — the same way on every surface and every day,
// without storing the choice anywhere.

export function stableBucket(key: string, buckets: number): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % buckets
}
