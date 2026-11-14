export type Side = 'LONG' | 'SHORT' | 'NEUTRAL';

export interface Factor { s: number; w_pct: number; note: string }
export interface Levels { entry: number; sl: number; tp1: number; tp2: number; rr1: number; rr2: number; risk_pct: number; cost_r?: number }
export interface Regime { trend: 'TREND' | 'RANGE' | 'TRANSISI'; adx: number; vol: 'NORMAL' | 'TINGGI' | 'EKSTREM'; atr_pct: number }
export interface LiveInfo { mark: number | null; funding: number | null; next_funding: number | null }

export interface Analysis {
  mode?: 'swing' | 'scalp';
  symbol: string; price: number; side: Side; lean: Side; bias: number; confidence: number; tier: string;
  regime: Regime | null; levels: Levels | null; factors: Record<string, Factor>;
  reasons: string[]; warnings: string[]; vetoes: string[]; notes: string[];
  /** detik epoch saat harga diambil dari Binance */
  generated_at: number; price_at: number; live: LiveInfo;
}
export type Entry = Analysis | { error: string };
export const isErr = (e: Entry | undefined): e is { error: string } => !!e && 'error' in e;

export interface SymbolRow { symbol: string; price: number; change24h: number; quote_volume: number }
export interface Bar { time: number; open: number; high: number; low: number; close: number }
export interface CandleResp { candles: Bar[]; server_time: number }
export interface Stat { n: number; win_rate: number | null; avg_r: number | null; profit_factor: number | null }
export interface SignalRow {
  id: number; symbol: string; side: Side; confidence: number; bias: number; regime: string | null;
  entry: number; sl: number; tp1: number; tp2: number; rr1: number; rr2: number;
  status: 'open' | 'sl' | 'tp1' | 'tp2' | 'expired';
  /** hasil bersih setelah fee, slippage, dan funding (R) */
  r_result: number | null; gross_r: number | null; cost_r: number | null;
  opened_at: string; closed_at: string | null;
}
export interface HistoryResp { stats: { overall: Stat; open: number; buckets: Record<string, Stat> }; signals: SignalRow[] }
export interface TrackResp { resolved: number; open: SignalRow[] }
