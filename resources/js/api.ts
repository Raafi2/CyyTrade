import type { Analysis, CandleResp, HistoryResp, SymbolRow } from './types';

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  let body: unknown = null;
  try { body = await r.json(); } catch { /* bukan JSON */ }
  if (!r.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return body as T;
}

export const getSymbols = () => get<SymbolRow[]>('/api/symbols');
export const getAnalysis = (s: string) => get<Analysis>(`/api/analysis/${s}`);
export const getCandles = (s: string, tf: string) => get<CandleResp>(`/api/candles/${s}?tf=${tf}`);
export const getHistory = () => get<HistoryResp>('/api/history');
