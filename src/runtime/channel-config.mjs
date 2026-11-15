export function isQqEnabled(config) {
  return config?.channels?.qq?.enabled !== false;
}

export function isExternalChannelEnabled(config) {
  return config?.channels?.feishu?.enabled === true || config?.channels?.telegram?.enabled === true;
}

// Empty means no administrator; a configured QQ administrator must be a positive integer.
export function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

export function qqNeedsConfig(config) {
  if (!isQqEnabled(config) || !isExternalChannelEnabled(config)) return false;
  try { normalizeOwnerQQ(config.ownerQQ); }
  catch { return true; }
  return false;
}
