import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAnalysis, getCandles } from '../api';
import { alertPermission, notify, primeAlerts } from '../alerts';
import { base, fmtPrice, fmtUsd } from '../format';
import { markStream, symbolStreams, useStreams, useTicks, type LiveSnapshot } from '../live';
import * as P from '../position';
import type { Analysis, SymbolRow } from '../types';
import Chart from './Chart';

interface LogItem { t: number; m: string; k: 'info' | 'good' | 'bad' | 'warn' }
interface Pos {
  id: string;
  input: P.PositionInput;
  openedAt: number; // ms
  checkedAt: number; // detik: candle 1m sebelum ini sudah dicek
  status: 'open' | 'tp' | 'sl' | 'liq' | 'manual';
  closedAt?: number;
  closePrice?: number;
  net?: number;
  nearWarned?: boolean;
  flipWarned?: boolean;
  log: LogItem[];
}

const KEY = 'scalp.v1';
const SIGNAL_MS = 30_000;
const CANDLE_MS = 60_000;

function load(): Pos[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Pos[];
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

const hm = (t: number) => new Date(t).toLocaleTimeString('id-ID');
const sgn = (v: number) => `${v >= 0 ? '+' : '-'}${fmtUsd(Math.abs(v))}`;

/** Satu pemantau per posisi terbuka: harga tiap trade, candle yang terlewat, analisis scalp berkala. */
function Watcher({ pos, epoch, onPrice, onBars, onAnalysis }: {
  pos: Pos; epoch: number;
  onPrice: (id: string, price: number) => void;
  onBars: (id: string, bars: { time: number; high: number; low: number; close: number }[]) => void;
  onAnalysis: (id: string, a: Analysis) => void;
}) {
  const sym = pos.input.symbol;
  const id = pos.id;
  useTicks(sym, (p) => onPrice(id, p));

  const pullBars = useCallback(() => {
    getCandles(sym, '1m').then((d) => onBars(id, d.candles)).catch(() => { /* dicoba lagi */ });
  }, [sym, id, onBars]);
  const pullSignal = useCallback(() => {
    getAnalysis(sym, 'scalp').then((a) => onAnalysis(id, a)).catch(() => { /* dicoba lagi */ });
  }, [sym, id, onAnalysis]);

  useEffect(() => { pullBars(); pullSignal(); }, [pullBars, pullSignal, epoch]);
  useEffect(() => {
    const a = window.setInterval(pullBars, CANDLE_MS);
    const b = window.setInterval(pullSignal, SIGNAL_MS);
    const vis = () => { if (document.visibilityState === 'visible') { pullBars(); pullSignal(); } };
    document.addEventListener('visibilitychange', vis);
    return () => { window.clearInterval(a); window.clearInterval(b); document.removeEventListener('visibilitychange', vis); };
  }, [pullBars, pullSignal]);
  return null;
}

export interface Advice {
  sl: number; tp: number; note: string | null; src: string; capped: boolean; verdict: 'with' | 'neutral' | 'against'; maxLev: number; a: Analysis;
}

/** Saran SL/TP dari analisis scalp nyata. SL dibatasi supaya tidak melewati batas aman likuidasi pada leverage tsb. */
export function computeAdvice(a: Analysis, side: P.Side, e: number, L: number, cur?: number): Advice | null {
  if (!(e > 0) || !(L >= 1)) return null;
  const d = side === 'LONG' ? 1 : -1;
  let slD: number; let tpD: number; let src: string;
  if (a.levels && a.lean === side) {
    slD = Math.abs(a.levels.entry - a.levels.sl); tpD = Math.abs(a.levels.tp1 - a.levels.entry);
    src = `analisis scalp (SL swing+ATR 5m, TP = ${a.levels.rr1}R)`;
  } else if (a.regime) {
    slD = (1.2 * a.regime.atr_pct / 100) * e; tpD = 1.5 * slD;
    src = `ATR 5m ${a.regime.atr_pct}% (SL 1,2x ATR, TP 1,5R)`;
  } else return null;
  const safe = (1 / L - P.MMR) * e * 0.8;
  const capped = slD > safe;
  if (capped) { tpD *= safe / slD; slD = safe; }
  const dec = e >= 100 ? 2 : e >= 1 ? 4 : e >= 0.01 ? 5 : 7;
  // Entry boleh berbeda dari harga pasar (posisi yang Anda beli sendiri). Level dihitung dari entry;
  // bila harga sudah lewat SL atau TP itu, level disesuaikan ke harga sekarang.
  const price = cur ?? e;
  let sl = e - d * slD;
  let tp = e + d * tpD;
  let note: string | null = null;
  if (d * (price - sl) <= 0) {
    sl = price - d * slD;
    note = 'Harga sudah melewati SL ideal dari entry Anda. SL darurat dipasang dari harga sekarang; pertimbangkan cut loss.';
  } else if (d * (price - tp) >= 0) {
    sl = price - d * slD;
    tp = price + d * tpD;
    note = 'Harga sudah melewati target TP dari entry Anda. SL digeser mengikuti harga untuk mengunci profit dan TP baru dipasang.';
  }
  return {
    sl: Number(sl.toFixed(dec)), tp: Number(tp.toFixed(dec)), note, src, capped, a,
    verdict: a.side === side ? 'with' : a.side === 'NEUTRAL' ? 'neutral' : 'against',
    maxLev: Math.max(1, Math.floor(1 / (slD / e / 0.8 + P.MMR))),
  };
}

interface Props { live: LiveSnapshot; symbols: SymbolRow[] }

export default function Scalping({ live, symbols }: Props) {
  const [positions, setPositions] = useState<Pos[]>(load);
  const [selId, setSelId] = useState<string | null>(null);
  const [analyses, setAnalyses] = useState<Record<string, Analysis>>({});
  const [closes, setCloses] = useState<Record<string, number[]>>({});
  const [msg, setMsg] = useState<string | null>(null);

  // form
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [side, setSide] = useState<P.Side>('LONG');
  const [entry, setEntry] = useState('');
  const [margin, setMargin] = useState('10');
  const [lev, setLev] = useState('20');
  const [starting, setStarting] = useState(false);

  const posRef = useRef(positions);
  posRef.current = positions;
  const closing = useRef(new Set<string>());

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(positions)); } catch { /* abaikan */ }
  }, [positions]);

  const open = useMemo(() => positions.filter((p) => p.status === 'open'), [positions]);
  const closed = useMemo(() => positions.filter((p) => p.status !== 'open').sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)), [positions]);
  const sel = positions.find((p) => p.id === selId) ?? open[0] ?? closed[0] ?? null;

  const openSyms = useMemo(() => [...new Set(open.map((p) => p.input.symbol))], [open]);
  useStreams([...symbolStreams(openSyms), ...openSyms.map(markStream)]);

  // Cegah layar mati selama ada posisi terbuka (bila browser mendukung).
  useEffect(() => {
    if (open.length === 0 || !('wakeLock' in navigator)) return undefined;
    let lock: { release: () => Promise<void> } | null = null;
    let dead = false;
    const get = () => (navigator as unknown as { wakeLock: { request: (t: 'screen') => Promise<typeof lock> } }).wakeLock
      .request('screen').then((l) => { if (dead) void l?.release(); else lock = l; }).catch(() => { /* ditolak */ });
    void get();
    const vis = () => { if (document.visibilityState === 'visible') void get(); };
    document.addEventListener('visibilitychange', vis);
    return () => { dead = true; document.removeEventListener('visibilitychange', vis); void lock?.release(); };
  }, [open.length]);

  const patch = useCallback((id: string, fn: (p: Pos) => Pos) => {
    setPositions((ps) => ps.map((p) => (p.id === id ? fn(p) : p)));
  }, []);

  const closePos = useCallback((id: string, status: Exclude<Pos['status'], 'open'>, price: number, note?: string) => {
    if (closing.current.has(id)) return;
    const p = posRef.current.find((x) => x.id === id);
    if (!p || p.status !== 'open') return;
    closing.current.add(id);
    const net = status === 'liq' ? -p.input.margin : P.pnlNet(p.input, price);
    const name = `${base(p.input.symbol)} ${p.input.side}`;
    const text = status === 'tp' ? `TP kena ${name} di ${fmtPrice(price)}. Bersih ${sgn(net)} USDT`
      : status === 'sl' ? `SL kena ${name} di ${fmtPrice(price)}. Bersih ${sgn(net)} USDT`
        : status === 'liq' ? `LIKUIDASI ${name} di sekitar ${fmtPrice(price)}. Rugi ~${fmtUsd(p.input.margin)} USDT`
          : `Ditutup manual ${name} di ${fmtPrice(price)}. Bersih ${sgn(net)} USDT`;
    if (status !== 'manual') notify(status === 'tp' ? 'good' : 'bad', status === 'tp' ? `TP ${base(p.input.symbol)}` : status === 'sl' ? `SL ${base(p.input.symbol)}` : `LIKUIDASI ${base(p.input.symbol)}`, text);
    patch(id, (x) => ({
      ...x, status, closedAt: Date.now(), closePrice: price, net,
      log: [...x.log, { t: Date.now(), m: note ? `${text} (${note})` : text, k: status === 'tp' ? 'good' : 'bad' }],
    }));
  }, [patch]);

  const onPrice = useCallback((id: string, price: number) => {
    const p = posRef.current.find((x) => x.id === id);
    if (!p || p.status !== 'open') return;
    const ev = P.evaluate(p.input, price);
    if (ev === 'TP') closePos(id, 'tp', p.input.tp);
    else if (ev === 'SL') closePos(id, 'sl', price);
    else if (ev === 'LIQ') closePos(id, 'liq', price);
    else if (!p.nearWarned && P.nearSl(p.input, price)) {
      notify('warn', `Dekat SL ${base(p.input.symbol)}`, `${base(p.input.symbol)} ${p.input.side} tinggal ${fmtPrice(Math.abs(price - p.input.sl))} dari SL (${fmtPrice(p.input.sl)}).`);
      patch(id, (x) => ({ ...x, nearWarned: true, log: [...x.log, { t: Date.now(), m: `Harga ${fmtPrice(price)} sudah dekat SL ${fmtPrice(p.input.sl)}`, k: 'warn' }] }));
    }
  }, [closePos, patch]);

  const onBars = useCallback((id: string, bars: { time: number; high: number; low: number; close: number }[]) => {
    setCloses((c) => ({ ...c, [id]: bars.map((b) => b.close) }));
    const p = posRef.current.find((x) => x.id === id);
    if (!p || p.status !== 'open') return;
    // Candle yang terlewat sejak terakhir dicek (candle menit pembukaan sendiri dilewati).
    const hit = P.evaluateBars(p.input, bars, p.checkedAt);
    if (hit) {
      const price = hit.event === 'TP' ? p.input.tp : hit.event === 'SL' ? p.input.sl : P.liquidation(p.input.side, p.input.entry, p.input.leverage);
      closePos(id, hit.event.toLowerCase() as 'tp' | 'sl' | 'liq', price, `terdeteksi dari candle 1m ${hm(hit.time * 1000)}`);
    } else if (bars.length) {
      const nxt = bars[bars.length - 1].time; // candle berjalan dicek ulang di siklus berikutnya
      patch(id, (x) => (nxt > x.checkedAt ? { ...x, checkedAt: nxt } : x));
    }
  }, [closePos, patch]);

  const onAnalysis = useCallback((id: string, a: Analysis) => {
    setAnalyses((m) => ({ ...m, [id]: a }));
    const p = posRef.current.find((x) => x.id === id);
    if (!p || p.status !== 'open') return;
    if (live.mode === 'polling') onPrice(id, a.price);
    const against = a.side !== 'NEUTRAL' && a.side !== p.input.side;
    if (against && !p.flipWarned) {
      notify('warn', `Sinyal berbalik ${base(p.input.symbol)}`, `Analisis scalp kini ${a.side} (confidence ${a.confidence}) berlawanan dengan posisi ${p.input.side} Anda.`);
      patch(id, (x) => ({ ...x, flipWarned: true, log: [...x.log, { t: Date.now(), m: `Sinyal scalp berbalik ke ${a.side} (confidence ${a.confidence})`, k: 'warn' }] }));
    } else if (!against && p.flipWarned) {
      patch(id, (x) => ({ ...x, flipWarned: false }));
    }
  }, [live.mode, onPrice, patch]);

  // ---- form ----
  const nowPrice = live.ticks[symbol]?.price ?? symbols.find((s) => s.symbol === symbol)?.price;
  const entryNum = parseFloat(entry) || 0;
  const marginNum = parseFloat(margin) || 0;
  const levNum = parseFloat(lev) || 0;
  const formError = !(entryNum > 0 && marginNum > 0 && levNum >= 1) ? 'Isi entry, modal, dan leverage.' : null;
  const liqPreview = !formError ? P.liquidation(side, entryNum, levNum) : null;

  const useNow = () => { if (nowPrice) setEntry(String(nowPrice)); };

  const start = async () => {
    if (formError) { setMsg(formError); return; }
    const px = live.ticks[symbol]?.price ?? nowPrice;
    if (!px) { setMsg('Harga live belum tersedia. Tunggu sebentar lalu coba lagi.'); return; }
    setStarting(true);
    setMsg(null);
    try {
      const perm = await primeAlerts();
      const [a, c] = await Promise.all([getAnalysis(symbol, 'scalp'), getCandles(symbol, '1m')]);
      const adv = computeAdvice(a, side, entryNum, levNum, px);
      if (!adv) { setMsg('Data analisis belum cukup untuk menyarankan SL/TP. Coba lagi sebentar.'); return; }
      const input: P.PositionInput = { symbol, side, entry: entryNum, margin: marginNum, leverage: levNum, sl: adv.sl, tp: adv.tp };
      const err = P.validate(input);
      if (err) { setMsg(err); return; }
      if (P.evaluate(input, px) === 'LIQ') { setMsg(`Pada harga sekarang (${fmtPrice(px)}) posisi ini sudah melewati harga likuidasi (${fmtPrice(P.liquidation(side, entryNum, levNum))}).`); return; }
      const lv = P.levels(input);
      const eta = P.eta(input, entryNum, c.candles.map((x) => x.close));
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const now = Date.now();
      const verdict = adv.verdict === 'with' ? `analisis scalp mendukung ${side} (confidence ${a.confidence})`
        : adv.verdict === 'neutral' ? 'analisis scalp netral, tidak ada keunggulan jelas'
          : `analisis scalp BERLAWANAN (${a.side}, confidence ${a.confidence}); pertimbangkan tidak masuk`;
      const log: LogItem[] = [
        ...(Math.abs(px - entryNum) / px > 0.001 ? [{ t: now, m: `Entry Anda ${fmtPrice(entryNum)} berbeda dari harga pasar ${fmtPrice(px)}; dianggap sudah terisi sejak sebelum ini. Pemantauan dimulai dari sekarang.`, k: 'info' as const }] : []),
        { t: now, m: `Mulai dipantau: ${side} ${base(symbol)} entry ${fmtPrice(entryNum)}, ${levNum}x, modal ${fmtUsd(marginNum)} USDT`, k: 'info' },
        { t: now, m: `Saran dari ${adv.src}: SL ${fmtPrice(adv.sl)} (${sgn(lv.lossAtSl)} USDT), TP ${fmtPrice(adv.tp)} (${sgn(lv.gainAtTp)} USDT)${adv.capped ? '. SL dirapatkan karena leverage tinggi' : ''}`, k: 'info' },
        { t: now, m: `Penilaian: ${verdict}`, k: adv.verdict === 'against' ? 'warn' : 'info' },
      ];
      if (adv.note) log.push({ t: now, m: adv.note, k: 'warn' });
      if (eta) log.push({ t: now, m: `Perkiraan keluar ${P.fmtDuration(eta.expectedExitMin)}, peluang TP duluan ${(eta.pTp * 100).toFixed(0)}% (statistik volatilitas)`, k: 'info' });
      const p: Pos = { id, input, openedAt: now, checkedAt: Math.floor(now / 60_000) * 60 + 60, status: 'open', log };
      setPositions((ps) => [p, ...ps.filter((x) => x.status === 'open'), ...ps.filter((x) => x.status !== 'open').slice(0, 49)]);
      setAnalyses((m) => ({ ...m, [id]: a }));
      setCloses((m) => ({ ...m, [id]: c.candles.map((x) => x.close) }));
      setSelId(id);
      setMsg(perm === 'granted' ? null : 'Izin notifikasi browser belum diberikan. Bunyi, judul tab berkedip, dan banner tetap aktif.');
    } catch (e) {
      setMsg(`Gagal mengambil analisis: ${(e as Error).message}`);
    } finally { setStarting(false); }
  };

  /** Ubah SL/TP posisi terbuka (saran terbaru atau manual) setelah divalidasi. */
  const editLevels = (id: string, sl: number, tp: number): string | null => {
    const p = posRef.current.find((x) => x.id === id);
    if (!p) return 'Posisi tidak ditemukan.';
    const next = { ...p.input, sl, tp };
    const err = P.validate(next);
    if (err) return err;
    patch(id, (x) => ({ ...x, input: next, nearWarned: false, log: [...x.log, { t: Date.now(), m: `SL/TP diubah: SL ${fmtPrice(sl)}, TP ${fmtPrice(tp)}`, k: 'info' }] }));
    return null;
  };

  const closeNow = (p: Pos) => {
    const price = live.ticks[p.input.symbol]?.price ?? analyses[p.id]?.price;
    if (price) closePos(p.id, 'manual', price);
  };
  const remove = (id: string) => setPositions((ps) => ps.filter((p) => p.id !== id));

  // ---- chart & detail ----
  const selPrice = sel ? live.ticks[sel.input.symbol]?.price ?? analyses[sel.id]?.price : undefined;
  const chartLines = useMemo(() => {
    if (!sel) return undefined;
    const i = sel.input;
    return [
      { price: i.entry, color: '#d9a441', title: 'Entry' },
      { price: i.sl, color: '#e0524a', title: 'SL' },
      { price: i.tp, color: '#35b58a', title: 'TP' },
      { price: P.liquidation(i.side, i.entry, i.leverage), color: '#7a8493', title: 'Likuidasi', dotted: true },
    ];
  }, [sel]);

  return (
    <main className="grid scalp">
      {open.map((p) => (
        <Watcher key={p.id} pos={p} epoch={live.epoch} onPrice={onPrice} onBars={onBars} onAnalysis={onAnalysis} />
      ))}

      <section className="panel">
        <div className="panel-head"><span className="label">Posisi scalping</span></div>
        <div className="scroll">
          <div className="block">
            <h4>Posisi baru</h4>
            <div className="inputs two">
              <label>Pair
                <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
                  {(symbols.length ? symbols : [{ symbol: 'BTCUSDT' } as SymbolRow]).map((s) => <option key={s.symbol} value={s.symbol}>{base(s.symbol)}</option>)}
                </select>
              </label>
              <label>Arah
                <div className="seg">
                  <button className={side === 'LONG' ? 'on' : ''} onClick={() => setSide('LONG')}>LONG</button>
                  <button className={side === 'SHORT' ? 'on' : ''} onClick={() => setSide('SHORT')}>SHORT</button>
                </div>
              </label>
              <label>Entry
                <input inputMode="decimal" value={entry} onChange={(e) => setEntry(e.target.value)} placeholder={nowPrice ? `harga ${fmtPrice(nowPrice)} atau entry Anda` : 'entry Anda'} />
              </label>
              <label>Modal (USDT)<input inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value)} /></label>
              <label>Leverage (x)<input inputMode="decimal" value={lev} onChange={(e) => setLev(e.target.value)} /></label>
              <label>&nbsp;<button className="btn" onClick={useNow} disabled={!nowPrice}>Pakai harga sekarang</button></label>
            </div>
            {liqPreview !== null && (
              <dl className="kv mono preview">
                <dt>Ukuran posisi</dt><dd>{fmtUsd(P.notional({ margin: marginNum, leverage: levNum }))} USDT</dd>
                <dt>Likuidasi (perkiraan)</dt><dd>{fmtPrice(liqPreview)}</dd>
              </dl>
            )}
            <p className="fine">SL/TP tidak perlu diisi. Setelah "Mulai pantau", aplikasi menyarankan SL/TP dan perkiraan waktunya dari analisis nyata.</p>
            <button className="btn primary" onClick={() => void start()} disabled={starting}>{starting ? 'Menganalisis…' : 'Mulai pantau'}</button>
            {msg && <p className="fine">{msg}</p>}
            <p className="fine">Peringatan hanya jalan selama tab ini terbuka. Izin notifikasi: {alertPermission() === 'granted' ? 'aktif' : alertPermission() === 'unsupported' ? 'tidak didukung' : 'belum aktif'}.</p>
          </div>

          <div className="block">
            <h4>Dipantau ({open.length})</h4>
            {open.length === 0 && <p className="fine">Belum ada posisi.</p>}
            {open.map((p) => {
              const px = live.ticks[p.input.symbol]?.price ?? analyses[p.id]?.price;
              const n = px ? P.pnlNet(p.input, px) : null;
              return (
                <button key={p.id} className={`prow ${sel?.id === p.id ? 'on' : ''}`} onClick={() => setSelId(p.id)}>
                  <span className={p.input.side === 'LONG' ? 'long' : 'short'}>{p.input.side}</span>
                  <span>{base(p.input.symbol)}</span>
                  <span className="mono dim">{p.input.leverage}x</span>
                  <span className={`mono r ${n !== null ? (n >= 0 ? 'long' : 'short') : ''}`}>{n !== null ? sgn(n) : '-'}</span>
                </button>
              );
            })}
          </div>

          {closed.length > 0 && (
            <div className="block">
              <h4>Selesai <span className="dim">{closed.length}</span></h4>
              {closed.map((p) => (
                <div key={p.id} className={`prow ${sel?.id === p.id ? 'on' : ''}`} onClick={() => setSelId(p.id)} role="button" tabIndex={0}>
                  <span className={p.input.side === 'LONG' ? 'long' : 'short'}>{p.input.side}</span>
                  <span>{base(p.input.symbol)}</span>
                  <span className="mono dim">{p.status.toUpperCase()}</span>
                  <span className={`mono r ${(p.net ?? 0) >= 0 ? 'long' : 'short'}`}>{sgn(p.net ?? 0)}</span>
                </div>
              ))}
              <button className="btn" onClick={() => setPositions((ps) => ps.filter((p) => p.status === 'open'))}>Bersihkan daftar selesai</button>
            </div>
          )}
        </div>
      </section>

      {sel
        ? <Chart key={sel.input.symbol} symbol={sel.input.symbol} analysis={null} mode={live.mode} epoch={live.epoch} livePrice={selPrice} lines={chartLines} defaultTf="1m" />
        : <section className="panel chart"><div className="empty">Isi form lalu klik "Mulai pantau". Chart posisi muncul di sini.</div></section>}

      <section className="panel detail">
        {sel ? (
          <PositionDetail
            pos={sel} price={selPrice} mark={live.marks[sel.input.symbol]?.mark}
            closes={closes[sel.id]} analysis={analyses[sel.id]}
            onClose={() => closeNow(sel)} onRemove={() => remove(sel.id)} onEdit={(a, b) => editLevels(sel.id, a, b)}
          />
        ) : <div className="empty">Belum ada posisi dipilih.</div>}
      </section>
    </main>
  );
}

function PositionDetail({ pos, price, mark, closes, analysis, onClose, onRemove, onEdit }: {
  pos: Pos; price?: number; mark?: number; closes?: number[]; analysis?: Analysis; onClose: () => void; onRemove: () => void;
  onEdit: (sl: number, tp: number) => string | null;
}) {
  const i = pos.input;
  const isOpen = pos.status === 'open';
  const px = isOpen ? price : pos.closePrice;
  const lv = P.levels(i);
  const gross = px ? P.pnl(i, px) : null;
  const net = isOpen ? (px ? P.pnlNet(i, px) : null) : pos.net ?? null;
  const d = i.side === 'LONG' ? 1 : -1;
  const toSl = px ? (d * (px - i.sl) / px) * 100 : null;
  const toTp = px ? (d * (i.tp - px) / px) * 100 : null;
  const eta = isOpen && px && closes ? P.eta(i, px, closes) : null;
  const against = analysis && analysis.side !== 'NEUTRAL' && analysis.side !== i.side;
  const [edSl, setEdSl] = useState('');
  const [edTp, setEdTp] = useState('');
  const [edMsg, setEdMsg] = useState<string | null>(null);
  const adv = isOpen && analysis ? computeAdvice(analysis, i.side, i.entry, i.leverage, price) : null;
  const advIn = adv ? { ...i, sl: adv.sl, tp: adv.tp } : null;
  const advEta = advIn && px && closes && !P.validate(advIn) ? P.eta(advIn, px, closes) : null;
  const advDiffers = adv && (Math.abs(adv.sl - i.sl) / i.entry > 0.0005 || Math.abs(adv.tp - i.tp) / i.entry > 0.0005);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const age = Math.max(0, Math.floor((((isOpen ? Date.now() : pos.closedAt) ?? Date.now()) - pos.openedAt) / 60_000));

  return (
    <div className="scroll">
      <div className="block">
        <h4>{base(i.symbol)} <span className={i.side === 'LONG' ? 'long' : 'short'}>{i.side}</span> {i.leverage}x
          <span className="dim">{isOpen ? 'dipantau' : pos.status.toUpperCase()}</span></h4>
        <div className={`big mono ${net === null ? '' : net >= 0 ? 'long' : 'short'}`}>{net === null ? '-' : `${sgn(net)} USDT`}</div>
        <div className="fine">bersih setelah fee{px && gross !== null ? ` · ROI kotor ${((gross / i.margin) * 100).toFixed(1)}%` : ''}</div>
        <dl className="kv mono">
          <dt>Harga {isOpen ? 'sekarang' : 'penutupan'}</dt><dd>{fmtPrice(px)}</dd>
          {isOpen && mark !== undefined && <><dt>Mark price</dt><dd>{fmtPrice(mark)}</dd></>}
          <dt>Entry</dt><dd>{fmtPrice(i.entry)}</dd>
          <dt>Stop loss</dt><dd className="short">{fmtPrice(i.sl)} <i>({sgn(lv.lossAtSl)})</i></dd>
          <dt>Take profit</dt><dd className="long">{fmtPrice(i.tp)} <i>({sgn(lv.gainAtTp)})</i></dd>
          <dt>Likuidasi (perkiraan)</dt><dd>{fmtPrice(lv.liq)}</dd>
          {isOpen && toSl !== null && toTp !== null && (
            <>
              <dt>Jarak ke SL</dt><dd>{toSl.toFixed(2)}%</dd>
              <dt>Jarak ke TP</dt><dd>{toTp.toFixed(2)}%</dd>
            </>
          )}
          <dt>Lama berjalan</dt><dd>{age} mnt</dd>
        </dl>
      </div>

      {isOpen && (
        <div className="block">
          <h4>Perkiraan waktu <span className="dim">dari volatilitas 1m nyata</span></h4>
          {eta ? (
            <>
              <dl className="kv mono">
                <dt>Kemungkinan keluar</dt><dd>{P.fmtDuration(eta.expectedExitMin)}</dd>
                <dt>Sampai TP (median)</dt><dd>{P.fmtDuration(eta.medianTpMin)}</dd>
                <dt>Sampai SL (median)</dt><dd>{P.fmtDuration(eta.medianSlMin)}</dd>
                <dt>Peluang TP duluan</dt><dd>{(eta.pTp * 100).toFixed(0)}%</dd>
              </dl>
              <p className="fine">Model statistik tanpa asumsi arah: murni dari jarak ke TP/SL dan volatilitas terbaru. Bukan prediksi, dan harga bisa jauh lebih cepat atau lebih lambat.</p>
            </>
          ) : <p className="fine">Menunggu data candle 1m…</p>}
        </div>
      )}

      {isOpen && adv && (
        <div className="block">
          <h4>Saran SL/TP <span className="dim">dari analisis terbaru</span></h4>
          <dl className="kv mono">
            <dt>Saran SL</dt><dd className="short">{fmtPrice(adv.sl)}</dd>
            <dt>Saran TP</dt><dd className="long">{fmtPrice(adv.tp)}</dd>
            {advEta && <><dt>Perkiraan keluar</dt><dd>{P.fmtDuration(advEta.expectedExitMin)}</dd><dt>Peluang TP duluan</dt><dd>{(advEta.pTp * 100).toFixed(0)}%</dd></>}
          </dl>
          {adv.note && <p className="note-bad">{adv.note}</p>}
          <p className="fine">Dasar: {adv.src}{adv.capped ? '. SL dirapatkan karena leverage tinggi' : ''}.{adv.maxLev < i.leverage ? ` Leverage aman maksimal untuk SL ini ~${adv.maxLev}x.` : ''}</p>
          {advDiffers && <button className="btn" onClick={() => setEdMsg(onEdit(adv.sl, adv.tp))}>Pakai saran ini</button>}
          <div className="inputs two" style={{ marginTop: 8 }}>
            <label>SL manual<input inputMode="decimal" value={edSl} onChange={(e) => setEdSl(e.target.value)} placeholder={fmtPrice(i.sl)} /></label>
            <label>TP manual<input inputMode="decimal" value={edTp} onChange={(e) => setEdTp(e.target.value)} placeholder={fmtPrice(i.tp)} /></label>
          </div>
          <button className="btn" onClick={() => setEdMsg(onEdit(parseFloat(edSl) || i.sl, parseFloat(edTp) || i.tp))}>Terapkan manual</button>
          {edMsg && <p className="note-bad">{edMsg}</p>}
        </div>
      )}

      {isOpen && analysis && (
        <div className={`block ${against ? 'alert' : ''}`}>
          <h4>Sinyal scalp saat ini <span className="dim">1m / 5m / 15m</span></h4>
          <p className="mono">{analysis.side === 'NEUTRAL' ? `Netral (condong ${analysis.lean})` : analysis.side} · confidence {analysis.confidence}</p>
          {against && net !== null && net < 0 && <p className="note-bad"><b>Saran: cut loss.</b> Sinyal berlawanan dan posisi sudah rugi {sgn(net)} USDT; di SL rugi {sgn(lv.lossAtSl)} USDT.</p>}
          {against && !(net !== null && net < 0) && <p className="note-bad"><b>Saran: amankan profit atau tutup.</b> Sinyal berlawanan dengan posisi Anda.</p>}
          {!against && toTp !== null && toSl !== null && toTp < Math.abs(i.tp - i.entry) / i.entry * 50 && <p className="fine">Harga sudah lebih dari separuh jalan ke TP. Geser SL ke entry ({fmtPrice(i.entry)}) untuk mengunci posisi tanpa rugi.</p>}
          {analysis.vetoes.length > 0 && <ul>{analysis.vetoes.slice(0, 3).map((v) => <li key={v}>{v}</li>)}</ul>}
        </div>
      )}

      <div className="block">
        <h4>Catatan</h4>
        <div className="log mono">
          {[...pos.log].reverse().map((l, n) => <div key={n} className={l.k}><span className="dim">{hm(l.t)}</span> {l.m}</div>)}
        </div>
        <div className="row">
          {isOpen && <button className="btn" onClick={onClose}>Tutup manual di harga sekarang</button>}
          {!isOpen && <button className="btn" onClick={onRemove}>Hapus dari daftar</button>}
        </div>
      </div>
    </div>
  );
}
