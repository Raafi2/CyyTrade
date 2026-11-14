export function fmtPrice(p: number | null | undefined): string {
  if (p === null || p === undefined || Number.isNaN(p)) return '-';
  const d = p >= 1000 ? 2 : p >= 100 ? 2 : p >= 1 ? 4 : p >= 0.01 ? 5 : 7;
  return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
export const fmtPct = (v: number, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
export const base = (s: string) => s.replace(/USDT$/, '');
export function fmtUsd(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function sideWord(s: 'LONG' | 'SHORT' | 'NEUTRAL'): string {
  return s === 'LONG' ? 'naik' : s === 'SHORT' ? 'turun' : 'netral';
}
