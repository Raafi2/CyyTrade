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
  const [sl, setSl] = useState('');
  const [tp, setTp] = useState('');
  const [fillNote, setFillNote] = useState<string | null>(null);
  const [filling, setFilling] = useState(false);
  const [manual, setManual] = useState(false); // SL/TP diubah tangan: berhenti menimpa otomatis
  const [sug, setSug] = useState<{ symbol: string; a: Analysis; closes: number[] } | null>(null);

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
  const input: P.PositionInput = {
    symbol, side, entry: parseFloat(entry) || 0, margin: parseFloat(margin) || 0,
    leverage: parseFloat(lev) || 0, sl: parseFloat(sl) || 0, tp: parseFloat(tp) || 0,
  };
  const problem = P.validate(input);
  const lv = problem ? null : P.levels(input);
  const feeUsd = lv ? P.FEE_SIDE * P.notional(input) + P.FEE_SIDE * P.qty(input) * input.tp : 0;

  const useNow = () => { if (nowPrice) setEntry(String(nowPrice)); };
  // SL/TP otomatis: tiap pair/arah/entry berubah, analisis scalp nyata diambil dan SL/TP disarankan.
  useEffect(() => { setManual(false); }, [symbol, side]);
  const entryNum = parseFloat(entry);
  const hasEntry = entryNum > 0;
  useEffect(() => {
    if (!hasEntry) { setSug(null); setFillNote(null); return undefined; }
    let dead = false;
    setFilling(true);
    const t = window.setTimeout(() => {
      Promise.all([getAnalysis(symbol, 'scalp'), getCandles(symbol, '1m')])
        .then(([a, c]) => { if (!dead) { setSug({ symbol, a, closes: c.candles.map((x) => x.close) }); setFillNote(null); } })
        .catch((err: Error) => { if (!dead) setFillNote(`Gagal mengambil analisis: ${err.message}`); })
        .finally(() => { if (!dead) setFilling(false); });
    }, 600);
    return () => { dead = true; window.clearTimeout(t); };
  }, [symbol, hasEntry]);

  // Saran level dari analisis + leverage: SL tidak boleh melewati batas aman likuidasi.
  const advice = useMemo(() => {
    const e = entryNum;
    const L = parseFloat(lev) || 0;
    if (!sug || sug.symbol !== symbol || !(e > 0) || L < 1) return null;
    const a = sug.a;
    const d = side === 'LONG' ? 1 : -1;
    let slD: number; let tpD: number; let src: string;
    if (a.levels && a.lean === side) {
      slD = Math.abs(a.levels.entry - a.levels.sl); tpD = Math.abs(a.levels.tp1 - a.levels.entry);
      src = `analisis scalp (SL swing+ATR 5m, TP = ${a.levels.rr1}R)`;
    } else if (a.regime) {
      slD = (1.2 * a.regime.atr_pct / 100) * e; tpD = 1.5 * slD;
      src = `ATR 5m ${a.regime.atr_pct}% (SL 1,2x ATR, TP 1,5R)`;
    } else return null;
    const safe = (1 / L - P.MMR) * e * 0.8; // SL maksimal 80% jarak ke likuidasi
    const capped = slD > safe;
    if (capped) { tpD *= safe / slD; slD = safe; }
    const dec = e >= 100 ? 2 : e >= 1 ? 4 : e >= 0.01 ? 5 : 7;
    const slP = Number((e - d * slD).toFixed(dec));
    const tpP = Number((e + d * tpD).toFixed(dec));
    const verdict: 'with' | 'neutral' | 'against' = a.side === side ? 'with' : a.side === 'NEUTRAL' ? 'neutral' : 'against';
    const maxLev = Math.max(1, Math.floor(1 / (slD / e / 0.8 + P.MMR)));
    return { sl: slP, tp: tpP, src, capped, verdict, a, maxLev, input: { symbol, side, entry: e, margin: parseFloat(margin) || 0, leverage: L, sl: slP, tp: tpP } as P.PositionInput };
  }, [sug, entryNum, lev, side, symbol, margin]);

  useEffect(() => {
    if (!advice || manual) return;
    setSl(String(advice.sl));
    setTp(String(advice.tp));
    setFillNote(`SL/TP otomatis dari ${advice.src}${advice.capped ? '. SL dirapatkan karena leverage tinggi' : ''}. Ubah manual bila perlu.`);
  }, [advice, manual]);

  const adviceEta = advice && !manual && sug && advice.input.margin > 0 && !P.validate(advice.input) ? P.eta(advice.input, entryNum, sug.closes) : null;

  const start = async () => {
    if (problem) { setMsg(problem); return; }
    const px = live.ticks[symbol]?.price ?? nowPrice;
    if (!px) { setMsg('Harga live belum tersedia. Tunggu sebentar lalu coba lagi.'); return; }
    // Posisi dianggap sudah terisi di harga entry. Entry yang jauh dari pasar membuat SL/TP salah terpicu.
    if (Math.abs(px - input.entry) / px > 0.003) {
      setMsg(`Entry ${fmtPrice(input.entry)} berjarak lebih dari 0,3% dari harga sekarang (${fmtPrice(px)}). Pantau dimulai hanya untuk posisi yang sudah terisi: klik "Harga sekarang" atau isi entry sesuai fill Anda.`);
      return;
    }
    const perm = await primeAlerts();
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();
    const p: Pos = {
      id, input, openedAt: now, checkedAt: Math.floor(now / 60_000) * 60 + 60, status: 'open',
      log: [{ t: now, m: `Mulai dipantau: ${input.side} ${base(symbol)} entry ${fmtPrice(input.entry)}, SL ${fmtPrice(input.sl)}, TP ${fmtPrice(input.tp)}, ${input.leverage}x, modal ${fmtUsd(input.margin)} USDT`, k: 'info' }],
    };
    setPositions((ps) => [p, ...ps.filter((x) => x.status === 'open'), ...ps.filter((x) => x.status !== 'open').slice(0, 49)]);
    setSelId(id);
    setMsg(perm === 'granted' ? null : 'Izin notifikasi browser belum diberikan. Bunyi, judul tab berkedip, dan banner tetap aktif.');
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
                <input inputMode="decimal" value={entry} onChange={(e) => setEntry(e.target.value)} placeholder={nowPrice ? fmtPrice(nowPrice) : ''} />
              </label>
              <label>Modal (USDT)<input inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value)} /></label>
              <label>Leverage (x)<input inputMode="decimal" value={lev} onChange={(e) => setLev(e.target.value)} /></label>
              <label>&nbsp;<button className="btn" onClick={useNow} disabled={!nowPrice}>Harga sekarang</button></label>
              <label>Stop loss<input inputMode="decimal" value={sl} onChange={(e) => { setManual(true); setSl(e.target.value); }} /></label>
              <label>Take profit<input inputMode="decimal" value={tp} onChange={(e) => { setManual(true); setTp(e.target.value); }} /></label>
            </div>
            {manual && advice && <button className="btn" onClick={() => setManual(false)}>Kembalikan ke saran otomatis</button>}
            {filling && <p className="fine">Menganalisis…</p>}
            {fillNote && !filling && <p className="fine">{fillNote}</p>}
            {advice && (
              <div className={`advice ${advice.verdict}`}>
                {advice.verdict === 'with' && <b>Analisis scalp mendukung {side} (confidence {advice.a.confidence}).</b>}
                {advice.verdict === 'neutral' && <b>Analisis scalp netral. Tidak ada keunggulan jelas, pertimbangkan menunggu.</b>}
                {advice.verdict === 'against' && <b>Analisis scalp berlawanan ({advice.a.side}, confidence {advice.a.confidence}). Sebaiknya jangan masuk {side}.</b>}
                {advice.maxLev < (parseFloat(lev) || 0) && <div>Dengan SL ini, leverage aman maksimal ~{advice.maxLev}x.</div>}
                {advice.a.vetoes.slice(0, 2).map((v) => <div key={v}>{v}</div>)}
              </div>
            )}
            {adviceEta && (
              <p className="fine">Perkiraan: keluar sekitar {P.fmtDuration(adviceEta.expectedExitMin)} (TP median {P.fmtDuration(adviceEta.medianTpMin)}, SL median {P.fmtDuration(adviceEta.medianSlMin)}), peluang TP duluan {(adviceEta.pTp * 100).toFixed(0)}%. Statistik volatilitas, bukan prediksi arah.</p>
            )}

            {lv && (
              <dl className="kv mono preview">
                <dt>Jarak SL / TP</dt><dd>{lv.slPct.toFixed(2)}% / {lv.tpPct.toFixed(2)}% (R:R {lv.rr.toFixed(2)})</dd>
                <dt>Rugi di SL (bersih)</dt><dd className="short">{sgn(lv.lossAtSl)} USDT</dd>
                <dt>Untung di TP (bersih)</dt><dd className="long">{sgn(lv.gainAtTp)} USDT</dd>
                <dt>Likuidasi (perkiraan)</dt><dd>{fmtPrice(lv.liq)}</dd>
                <dt>Ukuran posisi</dt><dd>{fmtUsd(P.notional(input))} USDT</dd>
                <dt>Fee pergi-pulang</dt><dd>~{fmtUsd(feeUsd)} USDT</dd>
              </dl>
            )}
            {lv && Math.abs(lv.lossAtSl) > input.margin * 0.5 && <p className="note-bad">Rugi di SL lebih dari 50% modal. Kurangi leverage atau rapatkan SL.</p>}
            {lv && lv.gainAtTp > 0 && feeUsd > lv.gainAtTp * 0.3 && <p className="note-bad">Fee memakan lebih dari 30% target untung. Jarak TP terlalu dekat untuk scalping dengan modal ini.</p>}
            {problem && entry && sl && tp && <p className="note-bad">{problem}</p>}
            <button className="btn primary" onClick={() => void start()} disabled={!!problem}>Mulai pantau</button>
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
            onClose={() => closeNow(sel)} onRemove={() => remove(sel.id)}
          />
        ) : <div className="empty">Belum ada posisi dipilih.</div>}
      </section>
    </main>
  );
}

function PositionDetail({ pos, price, mark, closes, analysis, onClose, onRemove }: {
  pos: Pos; price?: number; mark?: number; closes?: number[]; analysis?: Analysis; onClose: () => void; onRemove: () => void;
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
