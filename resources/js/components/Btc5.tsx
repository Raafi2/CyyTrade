import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { getBtc5Feed, getCandles, type Btc5Feed } from '../api';
import {
  assess, DEFAULT_PARAMS, FlowTracker, resolveRecord, roundAt, seedVarPerSec, sigmaPerSec, SignalGate, summarize, VolEstimator,
  type Assessment, type Params, type Round, type RoundRecord, type Summary,
} from '../btc5';
import { fmtUsd } from '../format';

const WS_HOSTS = ['wss://stream.binance.com:9443', 'wss://data-stream.binance.vision'];
const STREAMS = 'btcusdt@bookTicker/btcusdt@aggTrade';
const FEED_FRESH_MS = 5_000;
const REC_KEY = 'btc5.records.v1';
const SET_KEY = 'btc5.settings.v1';

const hms = (sec: number) => new Date(sec * 1000).toLocaleTimeString('id-ID', { hour12: false });
const mmss = (sec: number) => { const s = Math.max(0, Math.ceil(sec)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const pc = (x: number | null, d = 0) => (x === null ? '–' : `${(x * 100).toFixed(d)}%`);
const pts = (x: number | null) => (x === null ? '–' : `${x >= 0 ? '+' : '-'}${Math.abs(x * 100).toFixed(1)}`);
const sgn = (v: number, d = 2) => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(d)}`;

interface Settings { minEdge: string; minSecLeft: string; band: string; confirmSec: string; feePct: string }
const DEFAULT_SET: Settings = { minEdge: '6', minSecLeft: '20', band: '25', confirmSec: '3', feePct: '0' };

function loadJson<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function saveJson(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* penyimpanan penuh/diblokir */ } }

function toParams(s: Settings): Params {
  const n = (x: string, d: number) => { const v = parseFloat(x); return Number.isFinite(v) ? v : d; };
  return {
    ...DEFAULT_PARAMS,
    minEdge: Math.max(0.01, n(s.minEdge, 6) / 100),
    minSecLeft: Math.max(3, n(s.minSecLeft, 20)),
    band: Math.min(0.9, Math.max(0, n(s.band, 25) / 100)),
    feePct: Math.max(0, n(s.feePct, 0)),
  };
}

interface View {
  now: number;
  round: Round;
  tau: number;
  mid: number | null;
  k: number | null;
  kExact: boolean;
  market: { up: number; down: number } | null;
  feedAge: number | null;
  pageLeft: number | null;
  refDiff: number | null;
  a: Assessment;
  sigma: { sigma: number; source: string } | null;
  flow: { book: number; trade: number; flow: number } | null;
  ws: 'connecting' | 'live' | 'down';
  state: 'confirmed' | 'pending' | 'none';
  rec: RoundRecord;
  series: Array<[number, number]>;
  samples: Array<{ t: number; pUp: number; mkt: number | null }>;
  summary: Summary;
  recs: RoundRecord[];
}

/** Semua state live berada di sini (di luar React) supaya pesan WebSocket yang sangat sering tidak memicu render. */
class Engine {
  vol = new VolEstimator();
  flow = new FlowTracker();
  gate = new SignalGate();
  params: Params = DEFAULT_PARAMS;
  confirmSec = 3;

  private ws: WebSocket | null = null;
  private wsState: 'connecting' | 'live' | 'down' = 'connecting';
  private hostIdx = 0;
  private fails = 0;
  private stopped = false;
  private lastMsg = 0;
  private mid = 0;
  private lastTick = 0;
  private seedVar: number | null = null;
  private feed: Btc5Feed | null = null;
  private feedAt = 0;
  private round: Round | null = null;
  private rec: RoundRecord | null = null;
  private kLocal: number | null = null;
  private samples: Array<{ t: number; pUp: number; mkt: number | null }> = [];
  private lastSample = 0;
  private recs: RoundRecord[] = loadJson<RoundRecord[]>(REC_KEY, []);
  private timers: number[] = [];

  start() {
    this.stopped = false;
    this.connect();
    void this.loadSeed();
    void this.pollFeed();
    this.timers.push(window.setInterval(() => void this.pollFeed(), 1000));
    this.timers.push(window.setInterval(() => void this.loadSeed(), 10 * 60_000));
    this.timers.push(window.setInterval(() => {
      if (this.wsState === 'live' && Date.now() - this.lastMsg > 10_000) this.ws?.close(); // koneksi membeku
    }, 3000));
  }

  stop() {
    this.stopped = true;
    this.timers.forEach((t) => window.clearInterval(t));
    this.timers = [];
    this.ws?.close();
  }

  private connect() {
    if (this.stopped) return;
    const host = WS_HOSTS[this.hostIdx % WS_HOSTS.length];
    let ws: WebSocket;
    try { ws = new WebSocket(`${host}/stream?streams=${STREAMS}`); } catch { this.down(); return; }
    this.ws = ws;
    this.wsState = 'connecting';
    const to = window.setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) ws.close(); }, 8000);
    ws.onopen = () => { window.clearTimeout(to); this.wsState = 'live'; this.fails = 0; this.lastMsg = Date.now(); };
    ws.onmessage = (ev: MessageEvent<string>) => this.onMsg(ev.data);
    ws.onclose = () => { window.clearTimeout(to); if (this.ws === ws) this.down(); };
    ws.onerror = () => { /* onclose menyusul */ };
  }

  private down() {
    this.ws = null;
    this.wsState = 'down';
    this.fails++;
    this.hostIdx++;
    if (!this.stopped) this.timers.push(window.setTimeout(() => this.connect(), Math.min(10_000, 1000 * this.fails)));
  }

  private onMsg(raw: string) {
    const now = Date.now();
    this.lastMsg = now;
    let d: { e?: string; b?: string; a?: string; B?: string; A?: string; q?: string; m?: boolean };
    try { d = (JSON.parse(raw) as { data?: typeof d }).data ?? {}; } catch { return; }
    if (d.e === 'aggTrade' && d.q !== undefined) {
      this.flow.pushTrade(now, parseFloat(d.q), d.m === false); // m=true: pembeli maker, jadi penjual agresor
    } else if (d.b !== undefined && d.a !== undefined) {
      const bid = parseFloat(d.b);
      const ask = parseFloat(d.a);
      if (bid > 0 && ask > 0) {
        this.mid = (bid + ask) / 2;
        this.lastTick = now;
        this.vol.push(now, this.mid);
        this.flow.pushBook(now, parseFloat(d.B ?? '0'), parseFloat(d.A ?? '0'));
      }
    }
  }

  private async loadSeed() {
    try {
      const r = await getCandles('BTCUSDT', '1m');
      this.seedVar = seedVarPerSec(r.candles.slice(-61).map((c) => c.close));
    } catch { /* dicoba lagi 10 menit kemudian; volatilitas live tetap jalan */ }
  }

  private async pollFeed() {
    if (document.visibilityState !== 'visible') return;
    try {
      const r = await getBtc5Feed();
      this.feed = r.feed;
      this.feedAt = Date.now() - (r.age_ms ?? 0);
    } catch { /* aplikasi sendiri sementara tidak terjangkau */ }
  }

  private persist() { saveJson(REC_KEY, this.recs.slice(0, 300)); }

  private newRec(r: Round): RoundRecord {
    return { start: r.start, end: r.end, index: r.index, k: null, kExact: false, signal: null, endPrice: null, outcome: null, win: null, pnl: null };
  }

  private finalize() {
    if (!this.rec) return;
    const r = this.rec;
    const end = this.vol.priceAt(r.end) ?? this.vol.priceAt(r.end - 1);
    const done = end !== null && r.k ? resolveRecord(r, end) : r;
    if (r.k || r.signal) { this.recs.unshift(done); this.persist(); }
  }

  tick(nowMs: number): View {
    const nowSec = nowMs / 1000;
    const round = roundAt(nowSec);
    if (!this.round || round.start !== this.round.start) {
      this.finalize();
      this.round = round;
      this.rec = this.newRec(round);
      this.samples = [];
      this.gate.reset();
      this.kLocal = this.vol.priceAt(round.start) ?? this.vol.priceAt(round.start + 1);
    }
    const rec = this.rec as RoundRecord;
    const fresh = this.feed !== null && nowMs - this.feedAt <= FEED_FRESH_MS;
    const sameRound = fresh && (this.feed?.expiry === undefined || this.feed.expiry === round.end);
    const f = sameRound ? this.feed : null;

    const live = nowMs - this.lastTick <= 5000 && this.mid > 0;
    const mid = live ? this.mid : null;

    let k: number | null = null;
    let kExact = false;
    if (f?.k) { k = f.k; kExact = true; } else if (this.kLocal) { k = this.kLocal; }
    rec.k = k;
    rec.kExact = kExact;

    const market = f && f.up !== undefined && f.down !== undefined ? { up: f.up / 100, down: f.down / 100 } : null;
    const sg = sigmaPerSec(this.vol.live(Math.floor(nowSec)), this.seedVar);
    const flow = live ? this.flow.value(nowMs) : null;
    const tau = round.end - nowSec;

    const a = mid
      ? assess({ s: mid, k, tau, sigmaSec: sg?.sigma ?? null, extraSd: kExact ? 1.5 : 5, market, flow: flow?.flow ?? null }, this.params)
      : assess({ s: 0, k, tau, sigmaSec: null, extraSd: 0, market: null, flow: null }, this.params);

    const buy = a.action === 'BUY_UP' || a.action === 'BUY_DOWN';
    const ok = this.gate.update(buy ? a.action : null, nowSec, this.confirmSec);
    let state: View['state'] = 'none';
    if (buy) state = ok ? 'confirmed' : 'pending';
    if (ok && buy && !rec.signal && market && a.side) {
      const up = a.side === 'UP';
      rec.signal = { t: nowSec, side: a.side, price: up ? market.up : market.down, pFair: (up ? a.wUp : a.wDown) ?? 0, edge: (up ? a.edgeUp : a.edgeDown) ?? 0 };
      this.persist();
    }

    if (a.pUp !== null && nowSec - this.lastSample >= 1) {
      this.samples.push({ t: nowSec, pUp: a.pUp, mkt: market ? market.up : null });
      this.lastSample = nowSec;
    }

    return {
      now: nowMs, round, tau, mid, k, kExact, market,
      feedAge: this.feed ? nowMs - this.feedAt : null,
      pageLeft: f?.left ?? null,
      refDiff: f?.ref && mid ? f.ref - mid : null,
      a, sigma: sg, flow, ws: this.wsState,
      state, rec: { ...rec },
      series: this.vol.series(round.start, Math.floor(nowSec)),
      samples: this.samples.slice(),
      summary: summarize(this.recs),
      recs: this.recs.slice(0, 20),
    };
  }
}

function Chart({ series, k, start, end, now }: { series: Array<[number, number]>; k: number | null; start: number; end: number; now: number }) {
  const W = 600;
  const H = 130;
  if (series.length < 2) return <div className="empty">Menunggu data harga ronde ini…</div>;
  const ys = series.map((s) => s[1]).concat(k ? [k] : []);
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  const pad = Math.max((hi - lo) * 0.15, 3);
  lo -= pad; hi += pad;
  const x = (t: number) => ((t - start) / (end - start)) * W;
  const y = (p: number) => H - ((p - lo) / (hi - lo)) * H;
  const pts2 = series.map(([t, p]) => `${x(t).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="btc5chart" preserveAspectRatio="none" role="img" aria-label="Harga BTC dalam ronde ini">
      {k ? <line x1={0} x2={W} y1={y(k)} y2={y(k)} stroke="var(--amber)" strokeDasharray="4 4" strokeWidth={1} /> : null}
      <line x1={x(now)} x2={x(now)} y1={0} y2={H} stroke="var(--line2)" strokeWidth={1} />
      <polyline points={pts2} fill="none" stroke="var(--text)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function ProbChart({ samples, start, end }: { samples: View['samples']; start: number; end: number }) {
  const W = 600;
  const H = 80;
  if (samples.length < 2) return null;
  const x = (t: number) => ((t - start) / (end - start)) * W;
  const y = (p: number) => H - Math.min(1, Math.max(0, p)) * H;
  const line = (vals: Array<[number, number]>) => vals.map(([t, p]) => `${x(t).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  const mk = samples.filter((s) => s.mkt !== null).map((s) => [s.t, s.mkt as number] as [number, number]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="btc5chart" preserveAspectRatio="none" role="img" aria-label="Peluang Naik: hitungan vs pasar">
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="var(--line2)" strokeWidth={1} />
      {mk.length > 1 ? <polyline points={line(mk)} fill="none" stroke="var(--muted)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" /> : null}
      <polyline points={line(samples.map((s) => [s.t, s.pUp] as [number, number]))} fill="none" stroke="var(--long)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const HEAD: Record<string, string> = {
  BUY_UP: 'BELI NAIK', BUY_DOWN: 'BELI TURUN', WAIT: 'TUNGGU', TOO_LATE: 'TERLAMBAT: TUNGGU RONDE BERIKUTNYA',
  NO_MARKET: 'ARAH SAJA (TANPA HARGA PASAR)', NO_DATA: 'DATA BELUM LENGKAP', ENDED: 'RONDE SELESAI',
};

export default function Btc5() {
  const eng = useRef<Engine | null>(null);
  const [v, setV] = useState<View | null>(null);
  const [set, setSet] = useState<Settings>(() => loadJson(SET_KEY, DEFAULT_SET));

  useEffect(() => {
    const e = new Engine();
    eng.current = e;
    e.start();
    setV(e.tick(Date.now()));
    const t = window.setInterval(() => setV(e.tick(Date.now())), 500);
    return () => { window.clearInterval(t); e.stop(); eng.current = null; };
  }, []);

  useEffect(() => {
    saveJson(SET_KEY, set);
    if (eng.current) {
      eng.current.params = toParams(set);
      const c = parseFloat(set.confirmSec);
      eng.current.confirmSec = Number.isFinite(c) ? Math.max(0, c) : 3;
    }
  }, [set]);

  if (!v) return <div className="empty">Memuat…</div>;
  const { a } = v;
  const p = toParams(set);
  const pageOk = v.feedAge !== null && v.feedAge <= FEED_FRESH_MS;
  const buy = a.action === 'BUY_UP' || a.action === 'BUY_DOWN';
  const head = buy && v.state === 'pending' ? 'MEMASTIKAN…' : a.action === 'NO_MARKET' && a.side ? `CONDONG ${a.side === 'UP' ? 'NAIK' : 'TURUN'} (TANPA HARGA PASAR)` : HEAD[a.action] ?? a.action;
  const tone = v.state === 'confirmed' ? (a.side === 'UP' ? 'long' : 'short') : 'dim';
  const setField = (k: keyof Settings) => (e: ChangeEvent<HTMLInputElement>) => setSet({ ...set, [k]: e.target.value });
  const s = v.summary;

  return (
    <div className="history botpage btc5">
      <div className="badges">
        <span className={`badge ${v.ws === 'live' ? 'ok' : v.ws === 'connecting' ? 'warn' : 'bad'}`}>
          {v.ws === 'live' ? 'Harga Binance: live' : v.ws === 'connecting' ? 'Harga Binance: menyambung…' : 'Harga Binance: terputus, mencoba lagi'}
        </span>
        <span className={`badge ${pageOk ? 'ok' : 'warn'}`}>{pageOk ? 'Halaman Binance: terbaca' : 'Halaman Binance: belum terbaca'}</span>
        <span className={`badge ${v.kExact ? 'ok' : 'warn'}`}>Acuan: {v.k ? (v.kExact ? 'dari halaman (tepat)' : 'dari harga Binance (perkiraan)') : 'belum ada'}</span>
      </div>

      {!pageOk && (
        <div className="banner info">
          Halaman Binance belum terbaca, jadi harga pasar (Naik/Turun %) dan harga acuan yang tepat belum ada. Pasang userscript: buka{' '}
          <a href="/cyytrade-binance.user.js" target="_blank" rel="noreferrer" className="mono">/cyytrade-binance.user.js</a> di browser yang ada Tampermonkey, klik Install,
          lalu buka halaman prediksi BTC 5 menit Binance (sudah login) dan biarkan tab itu terbuka. Lencana kecil di kiri bawah halaman Binance akan menunjukkan angka yang terbaca.
        </div>
      )}
      {v.ws === 'live' && document.visibilityState !== 'visible' && <div className="banner">Tab ini tersembunyi. Browser memperlambat timer di tab latar, jadi sinyal bisa terlewat. Biarkan tab ini terlihat.</div>}
      {v.refDiff !== null && Math.abs(v.refDiff) > 25 && (
        <div className="banner">Harga di halaman berbeda {fmtUsd(Math.abs(v.refDiff))} USD dari harga spot Binance BTC/USDT. Sumber penyelesaian pasar mungkin bukan pair ini, jadi hitungan bisa meleset.</div>
      )}

      <div className="stats">
        <div className="stat"><span className="label">Ronde</span><b className="mono">#{v.round.index}</b>
          <span className="mono dim">{hms(v.round.start)} → {hms(v.round.end)}</span></div>
        <div className="stat"><span className="label">Sisa waktu</span><b className="mono">{mmss(v.tau)}</b>
          <div className="prog"><i style={{ width: `${Math.min(100, Math.max(0, ((300 - v.tau) / 300) * 100))}%` }} className="bg-long" /></div></div>
        <div className="stat"><span className="label">Harga sekarang (mid book)</span><b className="mono">{v.mid ? fmtUsd(v.mid) : '–'}</b>
          <span className="mono dim">{a.gap !== null ? `${sgn(a.gap)} dari acuan${a.z !== null ? ` · ${sgn(a.z)}σ` : ''}` : ' '}</span></div>
        <div className="stat"><span className="label">Harga yang perlu dikalahkan</span><b className="mono">{v.k ? fmtUsd(v.k) : '–'}</b>
          <span className="mono dim">{v.pageLeft !== null ? `halaman: sisa ${mmss(v.pageLeft)}` : v.kExact ? ' ' : 'perkiraan'}</span></div>
      </div>

      <div className={`block sigcard ${tone}`}>
        <div className={`big mono ${tone}`}>{head}</div>
        <p className="fine">{v.state === 'pending' ? 'Kondisi layak muncul; menunggu bertahan beberapa detik supaya tidak kedip.' : a.reason}</p>
        {v.rec.signal && (
          <p className="fine mono">Sinyal ronde ini dikunci {hms(v.rec.signal.t)}: <b className={v.rec.signal.side === 'UP' ? 'long' : 'short'}>{v.rec.signal.side === 'UP' ? 'NAIK' : 'TURUN'}</b> @ {pc(v.rec.signal.price)}, peluang wajar {pc(v.rec.signal.pFair)}.</p>
        )}
        <dl className="kv mono">
          <dt>Batas masuk (sisa ≥ {p.minSecLeft} dtk)</dt><dd>{hms(v.round.end - p.minSecLeft)}</dd>
          <dt>Naik layak bila harga ≥</dt><dd>{a.triggerUp !== null ? `${fmtUsd(a.triggerUp)}${v.mid ? ` (${sgn(a.triggerUp - v.mid)})` : ''}` : '–'}</dd>
          <dt>Turun layak bila harga ≤</dt><dd>{a.triggerDown !== null ? `${fmtUsd(a.triggerDown)}${v.mid ? ` (${sgn(a.triggerDown - v.mid)})` : ''}` : '–'}</dd>
        </dl>
        <p className="fine">Level di atas dihitung dengan sisa waktu dan harga pasar saat ini; keduanya berubah tiap detik.</p>
      </div>

      <div className="stats">
        <div className="stat"><span className="label">Peluang wajar Naik / Turun</span>
          <b className="mono">{pc(a.pUp)} / {pc(a.pDown)}</b><span className="mono dim">konservatif {pc(a.wUp)} / {pc(a.wDown)}</span></div>
        <div className="stat"><span className="label">Harga pasar Naik / Turun</span>
          <b className="mono">{v.market ? `${pc(v.market.up)} / ${pc(v.market.down)}` : '–'}</b><span className="mono dim">dari halaman Binance</span></div>
        <div className="stat"><span className="label">Selisih Naik / Turun (poin)</span>
          <b className={`mono ${(a.edgeUp ?? 0) >= p.minEdge ? 'long' : ''}`}>{pts(a.edgeUp)} / <span className={(a.edgeDown ?? 0) >= p.minEdge ? 'long' : ''}>{pts(a.edgeDown)}</span></b>
          <span className="mono dim">butuh ≥ {(p.minEdge * 100).toFixed(1)}</span></div>
        <div className="stat"><span className="label">Untung per $1 (konservatif)</span>
          <b className="mono">{a.evUp !== null && a.evDown !== null ? `${sgn(a.evUp * 100, 0)}% / ${sgn(a.evDown * 100, 0)}%` : '–'}</b><span className="mono dim">Naik / Turun, sebelum slippage</span></div>
        <div className="stat"><span className="label">Volatilitas</span>
          <b className="mono">{a.sigmaAbs !== null ? `$${(a.sigmaAbs * Math.sqrt(60)).toFixed(1)}/mnt` : '–'}</b><span className="mono dim">{v.sigma ? `sumber: ${v.sigma.source}` : ' '}</span></div>
        <div className="stat"><span className="label">Tekanan order</span>
          <b className={`mono ${v.flow ? (v.flow.flow > 0.15 ? 'long' : v.flow.flow < -0.15 ? 'short' : '') : ''}`}>{v.flow ? sgn(v.flow.flow) : '–'}</b>
          <span className="mono dim">{v.flow ? `book ${sgn(v.flow.book)} · trade ${sgn(v.flow.trade)}` : ' '}</span></div>
      </div>

      <h4 className="pad label">Harga BTC dalam ronde ini <span className="dim">(garis putus = harga acuan)</span></h4>
      <Chart series={v.series} k={v.k} start={v.round.start} end={v.round.end} now={v.now / 1000} />
      <h4 className="pad label">Peluang Naik <span className="dim">(hijau = hitungan, abu = harga pasar)</span></h4>
      <ProbChart samples={v.samples} start={v.round.start} end={v.round.end} />

      <h4 className="pad label">Pengaturan sinyal</h4>
      <div className="block">
        <div className="inputs two">
          <label>Selisih minimum (poin %) setelah dikurangi ketidakpastian<input inputMode="decimal" value={set.minEdge} onChange={setField('minEdge')} /></label>
          <label>Sisa waktu minimum untuk masuk (detik)<input inputMode="numeric" value={set.minSecLeft} onChange={setField('minSecLeft')} /></label>
          <label>Pelebaran volatilitas untuk batas konservatif (%)<input inputMode="decimal" value={set.band} onChange={setField('band')} /></label>
          <label>Sinyal harus bertahan (detik)<input inputMode="numeric" value={set.confirmSec} onChange={setField('confirmSec')} /></label>
          <label>Biaya (% dari nominal beli; isi bila Binance mengenakan fee)<input inputMode="decimal" value={set.feePct} onChange={setField('feePct')} /></label>
        </div>
        <button className="btn" onClick={() => setSet(DEFAULT_SET)}>Kembalikan bawaan</button>
      </div>

      <h4 className="pad label">Hasil nyata sinyal <span className="dim">(dicatat selama tab ini terbuka)</span></h4>
      <div className="stats">
        <div className="stat"><span className="label">Ronde tercatat</span><b className="mono">{s.rounds}</b><span className="mono dim">{s.signals} dengan sinyal</span></div>
        <div className="stat"><span className="label">Menang</span><b className="mono">{s.winRate === null ? '–' : `${(s.winRate * 100).toFixed(0)}%`}</b>
          <span className="mono dim">{s.wins} dari {s.decided} · peluang wajar rata-rata {pc(s.avgFair)}</span></div>
        <div className="stat"><span className="label">Untung hipotetis per $1 per sinyal</span><b className={`mono ${s.pnl > 0 ? 'long' : s.pnl < 0 ? 'short' : ''}`}>{s.signals ? sgn(s.pnl) : '–'}</b>
          <span className="mono dim">tanpa fee dan slippage</span></div>
      </div>
      <div className="table-wrap">
        <table className="mono">
          <thead><tr><th>Ronde</th><th>Berakhir</th><th>Acuan</th><th>Akhir</th><th>Hasil</th><th>Sinyal</th><th>Peluang wajar</th><th>Menang?</th><th>Per $1</th></tr></thead>
          <tbody>
            {v.recs.map((r) => (
              <tr key={r.start}>
                <td>#{r.index}</td><td>{hms(r.end)}</td><td>{r.k ? fmtUsd(r.k) : '–'}{r.k && !r.kExact ? '*' : ''}</td><td>{r.endPrice ? fmtUsd(r.endPrice) : '–'}</td>
                <td className={r.outcome === 'UP' ? 'long' : r.outcome === 'DOWN' ? 'short' : 'dim'}>{r.outcome === 'UP' ? 'NAIK' : r.outcome === 'DOWN' ? 'TURUN' : r.outcome === 'TIE' ? 'SERI' : '–'}</td>
                <td className={r.signal ? (r.signal.side === 'UP' ? 'long' : 'short') : 'dim'}>{r.signal ? `${r.signal.side === 'UP' ? 'NAIK' : 'TURUN'} @ ${pc(r.signal.price)}` : 'tidak ada'}</td>
                <td>{r.signal ? pc(r.signal.pFair) : '–'}</td>
                <td className={r.win === null ? 'dim' : r.win ? 'long' : 'short'}>{r.win === null ? '–' : r.win ? 'ya' : 'tidak'}</td>
                <td className={r.pnl === null ? 'dim' : r.pnl >= 0 ? 'long' : 'short'}>{r.pnl === null ? '–' : sgn(r.pnl)}</td>
              </tr>
            ))}
            {!v.recs.length && <tr><td colSpan={9} className="empty">Belum ada ronde selesai. Biarkan tab terbuka; ronde pertama tercatat saat ronde berikutnya mulai.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="fine pad">* acuan dari harga Binance saat ronde mulai (perkiraan), bukan dari halaman.</p>

      <div className="block">
        <h4>Cara menghitung</h4>
        <p className="fine">Harga akhir ronde dianggap bergerak acak tanpa arah dengan volatilitas dari data live (return 10 detik, digabung kline 1 menit). Peluang Naik = peluang harga akhir lebih tinggi dari harga acuan, dihitung dengan distribusi berekor tebal (Student-t). Batas konservatif memakai volatilitas ±{(p.band * 100).toFixed(0)}% dan mengambil nilai terburuk untuk sisi yang dipilih. Selisih = peluang konservatif dikurangi harga pasar sisi itu. Tekanan order hanya menahan sinyal bila sangat berlawanan; ia tidak dipakai untuk meramal arah.</p>
        <p className="fine">Ini perkiraan statistik, bukan jaminan. Arah 5 menit BTC sangat mendekati acak; harga pasar sudah memuat banyak informasi, dan selisih kecil mudah habis oleh spread, slippage, dan fee. Jangan percaya sinyal sebelum tabel hasil nyata di atas berisi ratusan ronde dan win rate-nya konsisten di atas peluang wajar rata-rata. Tidak ada order yang dikirim dari aplikasi ini.</p>
      </div>
    </div>
  );
}
