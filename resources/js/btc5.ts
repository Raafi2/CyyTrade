// Logika murni sinyal BTC naik/turun 5 menit (tanpa React, tanpa simulasi).
// Hanya sintaks yang bisa dihapus tipenya (tanpa enum/parameter properties) supaya bisa dites langsung dengan Node.

export const ROUND_SEC = 300;

export type Side = 'UP' | 'DOWN';
export type Action = 'BUY_UP' | 'BUY_DOWN' | 'WAIT' | 'TOO_LATE' | 'NO_MARKET' | 'NO_DATA' | 'ENDED';

// ---------- ronde ----------

export interface Round {
    start: number; // detik epoch
    end: number;
    index: number; // ronde ke-berapa pada hari lokal (1..288), dihitung dari tanggal ronde berakhir
}

/** Ronde 5 menit yang sedang berjalan pada waktu `nowSec` (kelipatan 300 detik epoch). */
export function roundAt(nowSec: number): Round {
    const start = Math.floor(nowSec / ROUND_SEC) * ROUND_SEC;
    const end = start + ROUND_SEC;
    const d = new Date((end - 1) * 1000);
    const sod = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
    return { start, end, index: Math.round((end - sod) / ROUND_SEC) };
}

// ---------- probabilitas ----------

/** CDF distribusi Student-t dengan 5 derajat bebas (bentuk tertutup). Ekor lebih tebal dari normal. */
export function tCdf5(t: number): number {
    const th = Math.atan(t / Math.sqrt(5));
    const s = Math.sin(th);
    const c = Math.cos(th);
    return 0.5 + (th + s * c * (1 + (2 / 3) * c * c)) / Math.PI;
}

/**
 * Peluang harga akhir > harga acuan. Model gerak acak tanpa drift (pasar yang efisien):
 * gap = harga sekarang - harga acuan (USD), sigmaAbs = simpangan baku harga per sqrt(detik) (USD),
 * tau = sisa detik, extraSd = ketidakpastian tambahan (USD) dari selisih sumber/waktu harga.
 */
export function probUp(gap: number, sigmaAbs: number, tau: number, extraSd = 0): number {
    const varTotal = (tau > 0 && sigmaAbs > 0 ? sigmaAbs * sigmaAbs * tau : 0) + extraSd * extraSd;
    if (!(varTotal > 0)) return gap > 0 ? 1 : gap < 0 ? 0 : 0.5;
    return tCdf5((gap / Math.sqrt(varTotal)) * Math.sqrt(5 / 3));
}

/** Peluang terburuk untuk sisi UP dan DOWN bila sigma meleset +/- band (mis. 0.25 = 25%). */
export function worstCase(gap: number, sigmaAbs: number, tau: number, extraSd: number, band: number): { up: number; down: number; nom: number } {
    const nom = probUp(gap, sigmaAbs, tau, extraSd);
    const lo = probUp(gap, sigmaAbs * (1 - band), tau, extraSd);
    const hi = probUp(gap, sigmaAbs * (1 + band), tau, extraSd);
    return { nom, up: Math.min(nom, lo, hi), down: 1 - Math.max(nom, lo, hi) };
}

/** Gap (USD) terkecil/terbesar yang membuat f(gap) mencapai target; f harus naik terhadap gap. */
function solveGap(f: (gap: number) => number, target: number, span: number): number | null {
    let lo = -span;
    let hi = span;
    if (f(hi) < target || f(lo) > target) return null;
    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (f(mid) < target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
}

// ---------- volatilitas ----------

/** Rata-rata kuadrat return 1 menit dibagi 60 = varian log-return per detik. Butuh >= 15 close. */
export function seedVarPerSec(closes1m: number[]): number | null {
    if (closes1m.length < 16) return null;
    let sum = 0;
    let n = 0;
    for (let i = 1; i < closes1m.length; i++) {
        const r = Math.log(closes1m[i] / closes1m[i - 1]);
        if (Number.isFinite(r)) { sum += r * r; n++; }
    }
    return n >= 15 ? sum / n / 60 : null;
}

/** Menyimpan harga per detik dari feed live dan menaksir varian per detik dari return 10 detik (meredam noise mikrostruktur). */
export class VolEstimator {
    private bins = new Map<number, number>();
    private lastSec = 0;
    private lastPrice = 0;

    push(tMs: number, price: number): void {
        if (!(price > 0)) return;
        const s = Math.floor(tMs / 1000);
        if (this.lastSec && s > this.lastSec && s - this.lastSec <= 30) {
            for (let x = this.lastSec + 1; x < s; x++) this.bins.set(x, this.lastPrice); // isi detik tanpa update
        }
        if (s >= this.lastSec) { this.bins.set(s, price); this.lastSec = s; this.lastPrice = price; }
        if (this.bins.size > 900) {
            const cut = s - 800;
            for (const k of this.bins.keys()) if (k < cut) this.bins.delete(k);
        }
    }

    priceAt(sec: number): number | null {
        return this.bins.get(sec) ?? null;
    }

    /** Titik (detik, harga) dalam rentang, untuk grafik. */
    series(fromSec: number, toSec: number): Array<[number, number]> {
        const out: Array<[number, number]> = [];
        for (let t = fromSec; t <= toSec; t++) { const p = this.bins.get(t); if (p) out.push([t, p]); }
        return out;
    }

    live(nowSec: number): { variance: number; n: number } | null {
        const lag = 10;
        let sum = 0;
        let n = 0;
        for (let t = nowSec - 150; t <= nowSec; t++) {
            const a = this.bins.get(t);
            const b = this.bins.get(t - lag);
            if (a && b) { const r = Math.log(a / b); sum += r * r; n++; }
        }
        return n >= 40 ? { variance: sum / n / lag, n } : null;
    }
}

/** Gabungkan varian live dan varian seed (kline 1 menit). Hasil: simpangan baku log-return per detik. */
export function sigmaPerSec(live: { variance: number; n: number } | null, seedVar: number | null): { sigma: number; source: 'live+seed' | 'live' | 'seed' } | null {
    let v: number;
    let source: 'live+seed' | 'live' | 'seed';
    if (live && seedVar) {
        const w = Math.min(1, live.n / 120) * 0.6;
        v = w * live.variance + (1 - w) * seedVar;
        source = 'live+seed';
    } else if (live) { v = live.variance; source = 'live'; } else if (seedVar) { v = seedVar; source = 'seed'; } else return null;
    return { sigma: Math.max(Math.sqrt(v), 1e-5), source };
}

// ---------- tekanan order ----------

/** Tekanan order book (bid vs ask, dihaluskan 10 dtk) dan agresi pembeli vs penjual (30 dtk). Nilai -1..+1. */
export class FlowTracker {
    private trades: Array<{ t: number; q: number; buy: boolean }> = [];
    private book = 0;
    private bookAt = 0;

    pushBook(tMs: number, bidQty: number, askQty: number): void {
        const tot = bidQty + askQty;
        if (!(tot > 0)) return;
        const x = (bidQty - askQty) / tot;
        if (!this.bookAt) this.book = x;
        else this.book += (1 - Math.exp(-Math.max(0, tMs - this.bookAt) / 10_000)) * (x - this.book);
        this.bookAt = tMs;
    }

    pushTrade(tMs: number, qty: number, buyerAggressor: boolean): void {
        this.trades.push({ t: tMs, q: qty, buy: buyerAggressor });
        const cut = tMs - 30_000;
        while (this.trades.length && this.trades[0].t < cut) this.trades.shift();
    }

    value(nowMs: number): { book: number; trade: number; flow: number } {
        const cut = nowMs - 30_000;
        let b = 0;
        let s = 0;
        for (const x of this.trades) if (x.t >= cut) { if (x.buy) b += x.q; else s += x.q; }
        const trade = b + s > 0 ? (b - s) / (b + s) : 0;
        return { book: this.book, trade, flow: 0.5 * this.book + 0.5 * trade };
    }
}

// ---------- keputusan ----------

export interface Params {
    minEdge: number; // selisih minimum probabilitas wajar (konservatif) vs harga pasar, mis. 0.06
    minSecLeft: number; // sisa detik minimum agar masih sempat membeli
    band: number; // pelebaran sigma untuk batas konservatif, mis. 0.25
    minPrice: number; // abaikan sisi dengan harga pasar di bawah ini (longshot)
    maxPrice: number; // abaikan sisi dengan harga pasar di atas ini (bayaran terlalu kecil)
    feePct: number; // biaya % dari nominal beli (0 bila belum tahu)
    flowVeto: number; // |flow| di atas ini dan berlawanan arah = tahan sinyal
}

export const DEFAULT_PARAMS: Params = { minEdge: 0.06, minSecLeft: 20, band: 0.25, minPrice: 0.08, maxPrice: 0.92, feePct: 0, flowVeto: 0.5 };

export interface Inputs {
    s: number; // harga sekarang (mid book Binance)
    k: number | null; // harga yang perlu dikalahkan
    tau: number; // sisa detik
    sigmaSec: number | null; // simpangan baku log-return per detik
    extraSd: number; // USD, ketidakpastian sumber harga
    market: { up: number; down: number } | null; // 0..1
    flow: number | null;
}

export interface Assessment {
    action: Action;
    side: Side | null; // sisi yang direkomendasikan (atau yang condong bila belum ada harga pasar)
    reason: string;
    gap: number | null;
    z: number | null; // gap dalam satuan simpangan baku sisa waktu
    sigmaAbs: number | null; // USD per sqrt(detik)
    pUp: number | null; // nominal
    pDown: number | null;
    wUp: number | null; // konservatif
    wDown: number | null;
    edgeUp: number | null; // wUp - harga pasar Naik
    edgeDown: number | null;
    evUp: number | null; // untung per $1 modal (konservatif)
    evDown: number | null;
    triggerUp: number | null; // harga BTC yang membuat Naik layak (edge >= minEdge) sekarang
    triggerDown: number | null;
}

const EMPTY: Assessment = {
    action: 'NO_DATA', side: null, reason: '', gap: null, z: null, sigmaAbs: null, pUp: null, pDown: null, wUp: null, wDown: null,
    edgeUp: null, edgeDown: null, evUp: null, evDown: null, triggerUp: null, triggerDown: null,
};

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const pts = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)} poin`;

export function assess(i: Inputs, p: Params = DEFAULT_PARAMS): Assessment {
    if (!(i.s > 0)) return { ...EMPTY, reason: 'Menunggu harga live Binance.' };
    if (!(i.k && i.k > 0)) return { ...EMPTY, reason: 'Harga yang perlu dikalahkan belum diketahui. Pasang userscript di halaman Binance, atau tunggu ronde berikutnya.' };
    if (!i.sigmaSec) return { ...EMPTY, reason: 'Volatilitas belum cukup data. Tunggu sekitar 1 menit.' };

    const gap = i.s - i.k;
    const sigmaAbs = i.s * i.sigmaSec;
    if (!(i.tau > 0)) {
        return { ...EMPTY, action: 'ENDED', side: gap >= 0 ? 'UP' : 'DOWN', reason: 'Ronde berakhir.', gap, sigmaAbs, pUp: gap > 0 ? 1 : gap < 0 ? 0 : 0.5, pDown: gap > 0 ? 0 : gap < 0 ? 1 : 0.5 };
    }

    const w = worstCase(gap, sigmaAbs, i.tau, i.extraSd, p.band);
    const z = gap / Math.sqrt(sigmaAbs * sigmaAbs * i.tau + i.extraSd * i.extraSd);
    const base: Assessment = { ...EMPTY, gap, z, sigmaAbs, pUp: w.nom, pDown: 1 - w.nom, wUp: w.up, wDown: w.down };
    const lean: Side = w.nom >= 0.5 ? 'UP' : 'DOWN';

    if (!i.market) {
        return { ...base, action: 'NO_MARKET', side: lean, reason: `Tanpa harga pasar tidak ada selisih yang bisa dihitung. Condong ${lean === 'UP' ? 'Naik' : 'Turun'} ${pct(lean === 'UP' ? w.nom : 1 - w.nom)} (hanya arah, bukan sinyal beli).` };
    }

    const cUp = i.market.up;
    const cDown = i.market.down;
    const fee = 1 - p.feePct / 100;
    const edgeUp = w.up - cUp;
    const edgeDown = w.down - cDown;
    const evUp = cUp > 0 ? (w.up / cUp) * fee - 1 : null;
    const evDown = cDown > 0 ? (w.down / cDown) * fee - 1 : null;

    // Harga BTC yang membuat tiap sisi mencapai batas selisih saat ini (probabilitas konservatif naik terhadap gap).
    const span = Math.max(1, sigmaAbs * Math.sqrt(i.tau) * 8 + i.extraSd * 8);
    const gUp = cUp + p.minEdge < 0.995 ? solveGap((g) => worstCase(g, sigmaAbs, i.tau, i.extraSd, p.band).up, cUp + p.minEdge, span) : null;
    const gDown = cDown + p.minEdge < 0.995 ? solveGap((g) => 1 - worstCase(g, sigmaAbs, i.tau, i.extraSd, p.band).down, 1 - (cDown + p.minEdge), span) : null;
    const out: Assessment = {
        ...base, edgeUp, edgeDown, evUp, evDown,
        triggerUp: gUp === null ? null : i.k + gUp,
        triggerDown: gDown === null ? null : i.k + gDown,
    };

    const okUp = cUp >= p.minPrice && cUp <= p.maxPrice && edgeUp >= p.minEdge;
    const okDown = cDown >= p.minPrice && cDown <= p.maxPrice && edgeDown >= p.minEdge;
    let side: Side | null = null;
    if (okUp && okDown) side = edgeUp >= edgeDown ? 'UP' : 'DOWN';
    else if (okUp) side = 'UP';
    else if (okDown) side = 'DOWN';

    if (!side) {
        const best = edgeUp >= edgeDown ? 'UP' : 'DOWN';
        const e = best === 'UP' ? edgeUp : edgeDown;
        return {
            ...out, action: 'WAIT', side: null,
            reason: `Belum ada selisih cukup. Terbaik: ${best === 'UP' ? 'Naik' : 'Turun'} ${pts(e)} (butuh ${pts(p.minEdge)} setelah dikurangi ketidakpastian volatilitas).`,
        };
    }

    const e = side === 'UP' ? edgeUp : edgeDown;
    const wf = side === 'UP' ? w.up : w.down;
    const c = side === 'UP' ? cUp : cDown;
    const name = side === 'UP' ? 'Naik' : 'Turun';
    if (i.flow !== null && Math.abs(i.flow) >= p.flowVeto && (i.flow > 0) !== (side === 'UP')) {
        return { ...out, action: 'WAIT', side: null, reason: `${name} punya selisih ${pts(e)}, tapi tekanan order berlawanan arah kuat. Ditahan dulu.` };
    }
    if (i.tau < p.minSecLeft) {
        return { ...out, action: 'TOO_LATE', side: null, reason: `${name} sempat layak (${pts(e)}), tapi sisa ${Math.ceil(i.tau)} dtk, terlalu mepet untuk order.` };
    }
    return {
        ...out, action: side === 'UP' ? 'BUY_UP' : 'BUY_DOWN', side,
        reason: `${name}: peluang wajar konservatif ${pct(wf)} vs harga pasar ${pct(c)} (${pts(e)}).`,
    };
}

/** Sinyal baru dianggap valid bila bertahan beberapa detik (meredam kedip). */
export class SignalGate {
    private last: string | null = null;
    private since = 0;

    update(key: string | null, nowSec: number, confirmSec: number): boolean {
        if (key !== this.last) { this.last = key; this.since = nowSec; }
        return key !== null && nowSec - this.since >= confirmSec;
    }

    reset(): void { this.last = null; this.since = 0; }
}

// ---------- catatan hasil nyata ----------

export interface RoundRecord {
    start: number;
    end: number;
    index: number;
    k: number | null;
    kExact: boolean;
    signal: null | { t: number; side: Side; price: number; pFair: number; edge: number };
    endPrice: number | null;
    outcome: Side | 'TIE' | null;
    win: boolean | null;
    pnl: number | null; // hipotetis per $1 modal, tanpa fee
}

export function resolveRecord(r: RoundRecord, endPrice: number): RoundRecord {
    if (!r.k) return { ...r, endPrice, outcome: null, win: null, pnl: null };
    const outcome: Side | 'TIE' = endPrice > r.k ? 'UP' : endPrice < r.k ? 'DOWN' : 'TIE';
    if (!r.signal) return { ...r, endPrice, outcome, win: null, pnl: null };
    const c = r.signal.price;
    const win = outcome === 'TIE' ? null : outcome === r.signal.side;
    const pnl = outcome === 'TIE' ? 0.5 / c - 1 : win ? 1 / c - 1 : -1;
    return { ...r, endPrice, outcome, win, pnl };
}

export interface Summary {
    rounds: number;
    signals: number;
    decided: number;
    wins: number;
    winRate: number | null;
    avgFair: number | null; // rata-rata peluang wajar saat sinyal; bandingkan dengan winRate
    pnl: number; // hipotetis per $1 per sinyal, dijumlah
}

export function summarize(rs: RoundRecord[]): Summary {
    const sig = rs.filter((r) => r.signal && r.outcome);
    const decided = sig.filter((r) => r.win !== null);
    const wins = decided.filter((r) => r.win).length;
    return {
        rounds: rs.filter((r) => r.outcome).length,
        signals: sig.length,
        decided: decided.length,
        wins,
        winRate: decided.length ? wins / decided.length : null,
        avgFair: sig.length ? sig.reduce((a, r) => a + (r.signal?.pFair ?? 0), 0) / sig.length : null,
        pnl: sig.reduce((a, r) => a + (r.pnl ?? 0), 0),
    };
}
