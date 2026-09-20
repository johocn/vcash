/**
 * Vendure 金额单位为分（int），前端展示时除以 100 并保留两位小数。
 */
export function formatMoney(cents: number | null | undefined): string {
  if (cents == null) return '0.00';
  return (cents / 100).toFixed(2);
}
