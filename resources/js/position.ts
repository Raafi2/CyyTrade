// Logika murni posisi scalping (tanpa React, tanpa simulasi): hanya matematika dari harga live nyata.

export type Side = 'LONG' | 'SHORT';

export interface PositionInput {
    symbol: string;
    side: Side;
    entry: number;
    margin: number; // USDT
    leverage: number;
    sl: number;
    tp: number;
}

export const FEE_SIDE = 0.0005; // taker 0,05% per sisi
export const MMR = 0.005; // maintenance margin perkiraan (tier terendah)

const dir = (s: Side) => (s === 'LONG' ? 1 : -1);

export const notional = (p: Pick<PositionInput, 'margin' | 'leverage'>) => p.margin * p.leverage;
export const qty = (p: Pick<PositionInput, 'margin' | 'leverage' | 'entry'>) => notional(p) / p.entry;

/** Harga likuidasi isolated (perkiraan). */
export function liquidation(side: Side, entry: number, leverage: number): number {
    const d = dir(side);
    return entry * (1 - d * (1 / leverage - MMR));
}

/** PnL kotor dalam USDT pada harga tertentu. */
export function pnl(p: PositionInput, price: number): number {
    return dir(p.side) * (price - p.entry) * qty(p);
}

/** PnL bersih bila ditutup di harga tertentu (fee masuk + keluar). */
export function pnlNet(p: PositionInput, price: number): number {
    return pnl(p, price) - FEE_SIDE * notional(p) - FEE_SIDE * qty(p) * price;
}

export const roi = (p: PositionInput, price: number) => (pnl(p, price) / p.margin) * 100;

export interface Levels {
    slPct: number;
    tpPct: number;
    rr: number;
    lossAtSl: number; // USDT, bersih
    gainAtTp: number; // USDT, bersih
    liq: number;
    slBeyondLiq: boolean; // SL berada di luar harga likuidasi (SL tidak akan sempat jalan)
}

export function levels(p: PositionInput): Levels {
    const d = dir(p.side);
    const slPct = (Math.abs(p.entry - p.sl) / p.entry) * 100;
    const tpPct = (Math.abs(p.tp - p.entry) / p.entry) * 100;
    const liq = liquidation(p.side, p.entry, p.leverage);
    return {
        slPct,
        tpPct,
        rr: slPct > 0 ? tpPct / slPct : 0,
        lossAtSl: pnlNet(p, p.sl),
        gainAtTp: pnlNet(p, p.tp),
        liq,
        slBeyondLiq: d * (p.sl - liq) <= 0,
    };
}

/** Validasi sisi: SL dan TP harus di sisi yang benar dari entry. */
export function validate(p: PositionInput): string | null {
    const d = dir(p.side);
    if (!(p.entry > 0 && p.margin > 0 && p.leverage >= 1)) return 'Entry, modal, dan leverage harus lebih dari 0.';
    // SL boleh di atas entry (LONG) bila untuk mengunci profit, asal tetap di sisi rugi dari TP.
    if (!(d * (p.tp - p.sl) > 0)) return p.side === 'LONG' ? 'SL harus di bawah TP untuk LONG.' : 'SL harus di atas TP untuk SHORT.';
    if (!(d * (p.tp - p.entry) > 0)) return p.side === 'LONG' ? 'TP harus di atas entry untuk LONG.' : 'TP harus di bawah entry untuk SHORT.';
    if (levels(p).slBeyondLiq) return 'SL berada di luar harga likuidasi. Turunkan leverage atau rapatkan SL.';
    return null;
}

export type PosEvent = 'TP' | 'SL' | 'LIQ' | null;

/** Evaluasi satu harga terhadap posisi. Urutan konservatif: likuidasi, SL, lalu TP. */
export function evaluate(p: PositionInput, price: number): PosEvent {
    const d = dir(p.side);
    const liq = liquidation(p.side, p.entry, p.leverage);
    if (d * (price - liq) <= 0) return 'LIQ';
    if (d * (price - p.sl) <= 0) return 'SL';
    if (d * (price - p.tp) >= 0) return 'TP';
    return null;
}

/** Peringatan dini: jarak ke SL tersisa kurang dari frac dari jarak entry-SL. */
export function nearSl(p: PositionInput, price: number, frac = 0.25): boolean {
    const d = dir(p.side);
    const full = Math.abs(p.entry - p.sl);
    const left = d * (price - p.sl);
    return left > 0 && left < full * frac;
}

export interface Eta {
    sigmaPerMin: number; // volatilitas harga (fraksi) per menit
    pTp: number; // peluang menyentuh TP dulu, tanpa asumsi arah (driftless)
    medianTpMin: number | null;
    medianSlMin: number | null;
    expectedExitMin: number | null; // perkiraan waktu sampai salah satu level tersentuh
}

/**
 * Perkiraan waktu dari volatilitas realisasi (candle 1m nyata). Model gerak Brownian tanpa drift:
 * a = jarak ke SL, b = jarak ke TP (dalam fraksi harga), sigma per menit.
 *  - median waktu sentuh level berjarak d: (d / (0.6745 sigma))^2
 *  - peluang TP dulu: a / (a + b)
 *  - waktu keluar yang diharapkan: a b / sigma^2
 * Ini perkiraan statistik, bukan prediksi arah.
 */
export function eta(p: PositionInput, price: number, closes1m: number[]): Eta | null {
    if (closes1m.length < 15) return null;
    const rets: number[] = [];
    for (let i = 1; i < closes1m.length; i++) rets.push(Math.log(closes1m[i] / closes1m[i - 1]));
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
    const sigma = Math.sqrt(variance);
    if (!(sigma > 0)) return null;

    const d = dir(p.side);
    const a = (d * (price - p.sl)) / price; // jarak ke SL
    const b = (d * (p.tp - price)) / price; // jarak ke TP
    if (a <= 0 || b <= 0) return { sigmaPerMin: sigma, pTp: a <= 0 ? 0 : 1, medianTpMin: null, medianSlMin: null, expectedExitMin: null };

    const med = (x: number) => (x / (0.6745 * sigma)) ** 2;
    return {
        sigmaPerMin: sigma,
        pTp: a / (a + b),
        medianTpMin: med(b),
        medianSlMin: med(a),
        expectedExitMin: (a * b) / (sigma * sigma),
    };
}

export function fmtDuration(min: number | null): string {
    if (min == null || !isFinite(min)) return '-';
    if (min < 1) return '< 1 mnt';
    if (min < 90) return `~${Math.round(min)} mnt`;
    const h = min / 60;
    if (h < 48) return `~${h.toFixed(1)} jam`;
    return '> 2 hari';
}

export interface Bar1 { time: number; high: number; low: number }

/**
 * Cek candle 1m nyata yang terlewat (tab di latar belakang, koneksi putus, laptop tidur).
 * Bila SL dan TP tersentuh di candle yang sama dihitung SL (konservatif). Mengembalikan event pertama.
 */
export function evaluateBars(p: PositionInput, bars: Bar1[], afterSec: number): { event: Exclude<PosEvent, null>; time: number } | null {
    const d = dir(p.side);
    const liq = liquidation(p.side, p.entry, p.leverage);
    for (const b of bars) {
        if (b.time < afterSec) continue;
        const worst = d > 0 ? b.low : b.high;
        const best = d > 0 ? b.high : b.low;
        if (d * (worst - liq) <= 0) return { event: 'LIQ', time: b.time };
        if (d * (worst - p.sl) <= 0) return { event: 'SL', time: b.time };
        if (d * (best - p.tp) >= 0) return { event: 'TP', time: b.time };
    }
    return null;
}
