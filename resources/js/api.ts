import type { Analysis, BotResp, BotSettings, CandleResp, HistoryResp, IncomeResp, PortResp, SymbolRow, TrackResp } from './types';

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

async function post<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: unknown = null;
  try { data = await r.json(); } catch { /* bukan JSON */ }
  if (!r.ok) {
    const d = data as { error?: string; message?: string } | null;
    throw new Error(d?.error ?? d?.message ?? `HTTP ${r.status}`);
  }
  return data as T;
}

export const getSymbols = () => get<SymbolRow[]>('/api/symbols');
export const getAnalysis = (s: string, mode: 'swing' | 'scalp' = 'swing') =>
  get<Analysis>(`/api/analysis/${s}${mode === 'scalp' ? '?mode=scalp' : ''}`);
export const getCandles = (s: string, tf: string) => get<CandleResp>(`/api/candles/${s}?tf=${tf}`);
export const getHistory = () => get<HistoryResp>('/api/history');
export const getTrack = () => get<TrackResp>('/api/track');
export const getPortfolio = () => get<PortResp>('/api/portfolio');
export const getIncome = (from: number, to: number) => get<IncomeResp>(`/api/portfolio/income?from=${from}&to=${to}`);
export const getBot = () => get<BotResp>('/api/bot');
export const saveBotSettings = (s: BotSettings) => post<{ ok: boolean }>('/api/bot/settings', s);
export const startBot = () => post<{ ok: boolean }>('/api/bot/start');
export const stopBot = () => post<{ ok: boolean }>('/api/bot/stop');
export const panicBot = () => post<{ ok: boolean }>('/api/bot/panic');

export interface Btc5Feed {
    k?: number; ref?: number; up?: number; down?: number; expiry?: number; left?: number; title?: string; received_at: number;
}
export interface Btc5FeedResp { feed: Btc5Feed | null; age_ms: number | null; now: number }
export const getBtc5Feed = () => get<Btc5FeedResp>('/api/btc5/feed');
