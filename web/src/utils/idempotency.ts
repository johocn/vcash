/**
 * 幂等键生成：${prefix}_${uuid}。
 * 优先用 crypto.randomUUID，不支持时回退到 RFC4122 v4 手写实现。
 */
function uuid(): string {
  const g = typeof globalThis !== 'undefined' ? globalThis : (undefined as unknown);
  const c = (g as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function genIdempotencyKey(prefix: 'order' | 'payment' | 'session'): string {
  return `${prefix}_${uuid()}`;
}
