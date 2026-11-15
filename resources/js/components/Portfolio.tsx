import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { getAnalysis, getCandles, getIncome, getPortfolio } from '../api';
import { base, fmtPrice, fmtUsd } from '../format';
import { symbolStreams, useStreams, type LiveSnapshot } from '../live';
import * as P from '../position';
import type { Analysis, IncomeResp, PortPos, PortResp } from '../types';
import { computeAdvice } from './Scalping';

const sgn = (v: number) => `${v >= 0 ? '+' : '-'}${fmtUsd(Math.abs(v))}`;
const cls = (v: number) => (v > 0 ? 'long' : v < 0 ? 'short' : 'dim');
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOf = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 0, 0, 0, 0).getTime(); };
const endOf = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 23, 59, 59, 999).getTime(); };

type Preset = 'hari' | '7' | '30' | 'bulan' | 'semua' | 'kustom';

const pct = (v: number | null) => (v === null || !isFinite(v) ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

function presetRange(p: Exclude<Preset, 'kustom' | 'semua'>): [string, string] {
  const now = new Date();
  const today = ymd(now);
  if (p === 'hari') return [today, today];
  if (p === 'bulan') return [ymd(new Date(now.getFullYear(), now.getMonth(), 1)), today];
  const back = new Date(now); back.setDate(back.getDate() - (p === '7' ? 6 : 29));
  return [ymd(back), today];
}


/** Analisis scalping untuk satu posisi terbuka di akun: saran SL/TP, estimasi waktu, atau cut loss. */
function PositionAnalysis({ p, price }: { p: PortPos; price: number }) {
  const [a, setA] = useState<Analysis | null>(null);
  const [closes, setCloses] = useState<number[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    const pull = () => {
      Promise.all([getAnalysis(p.symbol, 'scalp'), getCandles(p.symbol, '1m')])
        .then(([an, c]) => { if (!dead) { setA(an); setCloses(c.candles.map((x) => x.close)); setErr(null); } })
        .catch((e: Error) => { if (!dead) setErr(e.message); });
    };
    pull();
    const t = setInterval(() => { if (document.visibilityState === 'visible') pull(); }, 30_000);
    return () => { dead = true; clearInterval(t); };
  }, [p.symbol]);

  if (err && !a) return <div className="banner">Analisis gagal: {err}</div>;
  if (!a) return <p className="fine">Menganalisis {base(p.symbol)}…</p>;

  const margin = p.leverage > 0 ? p.notional / p.leverage : 0;
  const adv = computeAdvice(a, p.side, p.entry, p.leverage, price);
  const against = a.side !== 'NEUTRAL' && a.side !== p.side;
  const losing = p.pnl < 0;
  const input: P.PositionInput | null = adv ? { symbol: p.symbol, side: p.side, entry: p.entry, margin, leverage: p.leverage, sl: adv.sl, tp: adv.tp } : null;
  const valid = !!input && margin > 0 && !P.validate(input);
  const lv = valid && input ? P.levels(input) : null;
  const eta = valid && input && closes ? P.eta(input, price, closes) : null;
  const emergency = !!adv?.note && adv.note.includes('SL ideal');

  let rec: { cls: string; text: string };
  if (against && losing) rec = { cls: 'against', text: `Saran: CUT LOSS. Analisis scalp kini ${a.side} (confidence ${a.confidence}), berlawanan dengan posisi ${p.side} yang sedang rugi.` };
  else if (emergency && losing) rec = { cls: 'against', text: 'Saran: pertimbangkan CUT LOSS. Harga sudah melewati SL ideal dari entry Anda.' };
  else if (against) rec = { cls: 'neutral', text: `Saran: amankan profit atau tutup sebagian. Analisis scalp kini ${a.side} (confidence ${a.confidence}), berlawanan dengan posisi Anda.` };
  else if (a.side === p.side) rec = { cls: 'with', text: `Analisis scalp masih mendukung ${p.side} (confidence ${a.confidence}). Tahan dengan SL/TP di bawah.` };
  else rec = { cls: 'neutral', text: 'Analisis scalp netral. Tidak ada keunggulan jelas; pasang SL yang disarankan dan jangan menambah posisi.' };

  return (
    <div className="pa">
      <div className={`advice ${rec.cls}`}><b>{rec.text}</b></div>
      {adv?.note && <p className="note-bad">{adv.note}</p>}
      {adv && (
        <dl className="kv mono">
          <dt>Saran SL</dt><dd className="short">{fmtPrice(adv.sl)}{lv ? <i> ({sgn(lv.lossAtSl)} USDT)</i> : null}</dd>
          <dt>Saran TP</dt><dd className="long">{fmtPrice(adv.tp)}{lv ? <i> ({sgn(lv.gainAtTp)} USDT)</i> : null}</dd>
          {eta && <><dt>Perkiraan keluar</dt><dd>{P.fmtDuration(eta.expectedExitMin)}</dd>
            <dt>TP / SL (median)</dt><dd>{P.fmtDuration(eta.medianTpMin)} / {P.fmtDuration(eta.medianSlMin)}</dd>
            <dt>Peluang TP duluan</dt><dd>{(eta.pTp * 100).toFixed(0)}%</dd></>}
          {p.liq > 0 && <><dt>Likuidasi Binance</dt><dd>{fmtPrice(p.liq)}</dd></>}
          <dt>Leverage aman (SL ini)</dt><dd>~{adv.maxLev}x{adv.maxLev < p.leverage ? ' (posisi Anda lebih tinggi)' : ''}</dd>
        </dl>
      )}
      {!adv && <p className="fine">Data belum cukup untuk menyarankan SL/TP.</p>}
      {adv && !valid && <p className="fine">Level yang disarankan tidak valid untuk posisi ini (mis. di luar batas likuidasi). Pertimbangkan menurunkan leverage atau menutup sebagian.</p>}
      {a.vetoes.slice(0, 2).map((v) => <p key={v} className="fine">{v}</p>)}
      <p className="fine">Dasar: {adv?.src ?? '-'} (candle 1m/5m/15m). Estimasi waktu adalah statistik volatilitas, bukan prediksi. Ini saran; Anda sendiri yang memasang order di Binance.</p>
    </div>
  );
}

export default function Portfolio({ live }: { live: LiveSnapshot }) {
  const [port, setPort] = useState<PortResp | null>(null);
  const [portErr, setPortErr] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>('7');
  const [range, setRange] = useState<[string, string]>(() => presetRange('7'));
  const [inc, setInc] = useState<IncomeResp | null>(null);
  const [incErr, setIncErr] = useState<string | null>(null);
  const [loadingInc, setLoadingInc] = useState(false);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (s: string) => setExpanded((e) => { const n = new Set(e); if (n.has(s)) n.delete(s); else n.add(s); return n; });

  const loadPort = useCallback(() => {
    getPortfolio().then((d) => { setPort(d); setPortErr(null); }).catch((e: Error) => setPortErr(e.message));
  }, []);
  useEffect(() => {
    loadPort();
    const t = setInterval(() => { if (document.visibilityState === 'visible') loadPort(); }, 15_000);
    return () => clearInterval(t);
  }, [loadPort]);

  const [from, to] = range;
  const loadInc = useCallback(() => {
    if (preset !== 'semua' && (!from || !to || startOf(from) > endOf(to))) return;
    setLoadingInc(true);
    // Selalu sampai sekarang: transaksi setelah rentang dipakai untuk menghitung saldo awal periode.
    getIncome(preset === 'semua' ? 1 : startOf(from), Date.now())
      .then((d) => { setInc(d); setIncErr(null); })
      .catch((e: Error) => setIncErr(e.message))
      .finally(() => setLoadingInc(false));
  }, [from, to, preset]);
  useEffect(() => { if (port?.configured) loadInc(); }, [port?.configured, loadInc]);

  const syms = useMemo(() => (port?.positions ?? []).map((p) => p.symbol), [port]);
  useStreams(symbolStreams(syms));

  const needle = q.trim().toLowerCase();
  const match = (s: string) => !needle || s.toLowerCase().includes(needle);

  const positions = useMemo(() => (port?.positions ?? []).filter((p) => match(p.symbol)).map((p) => {
    const px = live.ticks[p.symbol]?.price ?? p.mark;
    const pnl = (p.side === 'LONG' ? 1 : -1) * (px - p.entry) * p.amt;
    return { ...p, px, pnl };
  }), [port, live.ticks, needle]); // eslint-disable-line react-hooks/exhaustive-deps

  const allRecords = inc?.records ?? [];
  const periodStart = preset === 'semua' ? 0 : startOf(from);
  const periodEnd = preset === 'semua' ? Date.now() : endOf(to);
  const inPeriod = useMemo(() => allRecords.filter((r) => r.time >= periodStart && r.time <= periodEnd), [allRecords, periodStart, periodEnd]);
  const records = useMemo(() => inPeriod.filter((r) => r.type !== 'TRANSFER' && match(r.symbol)), [inPeriod, needle]); // eslint-disable-line react-hooks/exhaustive-deps

  // Saldo wallet di awal periode = saldo sekarang dikurangi semua profit dan transfer sejak awal periode.
  // Perkiraan: transaksi dalam aset non-stablecoin (mis. fee BNB) tidak ikut.
  const startBal = useMemo(() => {
    if (!port || port.wallet === undefined || !inc) return null;
    const since = allRecords.filter((r) => r.time >= periodStart).reduce((a, r) => a + r.income, 0);
    const v = port.wallet - since;
    return v > 0 ? v : null;
  }, [port, inc, allRecords, periodStart]);

  const agg = useMemo(() => {
    const byDay = new Map<string, { realized: number; fee: number; funding: number; transfer: number }>();
    const bySym = new Map<string, { realized: number; fee: number; funding: number; n: number }>();
    let win = 0; let lose = 0; let realized = 0; let fee = 0; let funding = 0;
    for (const r of inPeriod) {
      const day = ymd(new Date(r.time));
      const d = byDay.get(day) ?? { realized: 0, fee: 0, funding: 0, transfer: 0 };
      if (r.type === 'TRANSFER') { d.transfer += r.income; byDay.set(day, d); continue; }
      if (!match(r.symbol)) { byDay.set(day, d); continue; }
      const s = bySym.get(r.symbol) ?? { realized: 0, fee: 0, funding: 0, n: 0 };
      if (r.type === 'REALIZED_PNL') { d.realized += r.income; s.realized += r.income; s.n++; realized += r.income; if (r.income > 0) win++; else if (r.income < 0) lose++; }
      else if (r.type === 'COMMISSION') { d.fee += r.income; s.fee += r.income; fee += r.income; }
      else { d.funding += r.income; s.funding += r.income; funding += r.income; }
      byDay.set(day, d); bySym.set(r.symbol, s);
    }
    // Persen harian = profit hari itu / saldo di awal hari (dari saldo awal periode + akumulasi sebelumnya).
    const asc = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    // Saldo awal hari dihitung dari data tanpa filter pencarian agar persennya benar.
    const fullDay = new Map<string, number>();
    for (const r of inPeriod) { const k = ymd(new Date(r.time)); fullDay.set(k, (fullDay.get(k) ?? 0) + r.income); }
    let bal = startBal;
    const days = asc.map(([k, v]) => {
      const net = v.realized + v.fee + v.funding;
      const p = bal !== null && bal > 0 ? (net / bal) * 100 : null;
      if (bal !== null) bal += fullDay.get(k) ?? 0;
      return [k, v, p] as const;
    }).reverse();
    const syms2 = [...bySym.entries()].sort((a, b) => (b[1].realized + b[1].fee + b[1].funding) - (a[1].realized + a[1].fee + a[1].funding));
    return { days, syms: syms2, win, lose, realized, fee, funding, net: realized + fee + funding };
  }, [inPeriod, startBal, needle]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickPreset = (p: Preset) => {
    setPreset(p);
    if (p !== 'kustom' && p !== 'semua') setRange(presetRange(p));
  };

  if (portErr && !port) return <div className="banner">Portofolio gagal dimuat: {portErr}</div>;
  if (!port) return <div className="empty">Memuat portofolio…</div>;
  if (!port.configured) {
    return (
      <div className="history">
        <div className="block">
          <h4>Portofolio belum diatur</h4>
          <p>Fitur ini membaca akun Binance Futures Anda secara <b>read-only</b>. Langkah:</p>
          <ol className="fine">
            <li>Binance → API Management → buat API key baru. Aktifkan <b>hanya "Enable Reading"</b>. Jangan aktifkan Futures trading, withdraw, atau transfer.</li>
            <li>Batasi key ke IP publik Anda (Restrict access to trusted IPs only).</li>
            <li>Isi di file <span className="mono">.env</span>: <span className="mono">BINANCE_API_KEY=…</span> dan <span className="mono">BINANCE_API_SECRET=…</span>. Jangan tempel key di chat atau commit ke Git.</li>
            <li>Jalankan <span className="mono">php artisan config:clear</span>, lalu muat ulang halaman ini.</li>
          </ol>
          <p className="fine">Aplikasi ini tidak punya login, jadi data akun hanya dilayani ke localhost.</p>
        </div>
      </div>
    );
  }

  const unreal = positions.reduce((a, p) => a + p.pnl, 0);
  return (
    <div className="history">
      {portErr && <div className="banner">Pembaruan portofolio gagal: {portErr}</div>}
      <div className="stats">
        <div className="stat"><span className="label">Saldo wallet</span><b className="mono">{fmtUsd(port.wallet ?? 0)}</b></div>
        <div className="stat"><span className="label">PnL belum terealisasi {needle ? '(terfilter)' : ''}</span><b className={`mono ${cls(unreal)}`}>{sgn(unreal)}</b>
          <span className={`mono ${cls(unreal)}`}>{pct(port.wallet ? (unreal / port.wallet) * 100 : null)} dari saldo wallet</span></div>
        <div className="stat"><span className="label">Saldo margin</span><b className="mono">{fmtUsd(port.margin_balance ?? 0)}</b></div>
        <div className="stat"><span className="label">Tersedia</span><b className="mono">{fmtUsd(port.available ?? 0)}</b></div>
      </div>

      <div className="toolbar">
        <input className="search" placeholder="Cari pair, mis. BTC" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg">
          {([['hari', 'Hari ini'], ['7', '7 hari'], ['30', '30 hari'], ['bulan', 'Bulan ini'], ['semua', 'Semua'], ['kustom', 'Kustom']] as [Preset, string][]).map(([k, l]) => (
            <button key={k} className={preset === k ? 'on' : ''} onClick={() => pickPreset(k)}>{l}</button>
          ))}
        </div>
        <input type="date" disabled={preset === 'semua'} value={from} max={to} onChange={(e) => { setPreset('kustom'); setRange([e.target.value, to]); }} />
        <span className="dim">s/d</span>
        <input type="date" disabled={preset === 'semua'} value={to} min={from} max={ymd(new Date())} onChange={(e) => { setPreset('kustom'); setRange([from, e.target.value]); }} />
        <button className="btn" onClick={loadInc} disabled={loadingInc}>{loadingInc ? 'Memuat…' : 'Muat'}</button>
      </div>

      <div className="stats">
        <div className="stat"><span className="label">Total profit bersih</span><b className={`mono ${cls(agg.net)}`}>{sgn(agg.net)}</b>
          <span className={`mono ${cls(agg.net)}`}>{pct(startBal ? (agg.net / startBal) * 100 : null)} dari saldo awal{startBal ? ` (${fmtUsd(startBal)})` : ''}</span>
          <span className="mono dim">{preset === 'semua' ? 'semua data tersimpan' : `${from} s/d ${to}`}{needle ? ` · "${q}"` : ''}</span></div>
        <div className="stat"><span className="label">PnL terealisasi</span><b className={`mono ${cls(agg.realized)}`}>{sgn(agg.realized)}</b>
          <span className="mono dim">{agg.win} untung · {agg.lose} rugi</span></div>
        <div className="stat"><span className="label">Fee</span><b className={`mono ${cls(agg.fee)}`}>{sgn(agg.fee)}</b></div>
        <div className="stat"><span className="label">Funding</span><b className={`mono ${cls(agg.funding)}`}>{sgn(agg.funding)}</b></div>
      </div>
      {incErr && <div className="banner">Data profit gagal dimuat: {incErr}</div>}
      {inc?.sync_error && <div className="banner">Sinkron dari Binance gagal ({inc.sync_error}). Menampilkan data yang sudah tersimpan.</div>}
      {inc?.truncated && <div className="banner">Data sangat banyak dan dipotong. Persempit rentang tanggal.</div>}

      <h4 className="pad label">Posisi terbuka ({positions.length})</h4>
      <div className="table-wrap">
        <table className="mono">
          <thead><tr><th></th><th>Pair</th><th>Arah</th><th>Jumlah</th><th>Entry</th><th>Harga</th><th>Likuidasi</th><th>Lev</th><th>PnL</th><th>ROI</th></tr></thead>
          <tbody>
            {positions.map((p) => {
              const isOpen = expanded.has(p.symbol);
              return (
                <Fragment key={p.symbol}>
                  <tr>
                    <td><button className="chev" aria-expanded={isOpen} aria-label={`Analisis ${base(p.symbol)}`} onClick={() => toggle(p.symbol)}>{isOpen ? '⌄' : '›'}</button></td>
                    <td>{base(p.symbol)}</td>
                    <td className={p.side === 'LONG' ? 'long' : 'short'}>{p.side}</td>
                    <td>{p.amt}</td><td>{fmtPrice(p.entry)}</td><td>{fmtPrice(p.px)}</td>
                    <td>{p.liq > 0 ? fmtPrice(p.liq) : '–'}</td>
                    <td>{p.leverage}x <i className="dim">{p.margin_type}</i></td>
                    <td className={cls(p.pnl)}>{sgn(p.pnl)}</td>
                    <td className={cls(p.pnl)}>{pct(p.leverage > 0 && p.notional > 0 ? (p.pnl / (p.notional / p.leverage)) * 100 : null)}</td>
                  </tr>
                  {isOpen && <tr className="expand"><td colSpan={10}><PositionAnalysis p={p} price={p.px} /></td></tr>}
                </Fragment>
              );
            })}
            {!positions.length && <tr><td colSpan={10} className="empty">{needle ? 'Tidak ada posisi yang cocok.' : 'Tidak ada posisi terbuka.'}</td></tr>}
          </tbody>
        </table>
      </div>

      <h4 className="pad label">Per hari</h4>
      <div className="table-wrap">
        <table className="mono">
          <thead><tr><th>Tanggal</th><th>Terealisasi</th><th>Fee</th><th>Funding</th><th>Bersih</th><th>%</th></tr></thead>
          <tbody>
            {agg.days.map(([d, v, p]) => {
              const net = v.realized + v.fee + v.funding;
              return <tr key={d}><td>{d}</td><td className={cls(v.realized)}>{sgn(v.realized)}</td><td className={cls(v.fee)}>{sgn(v.fee)}</td><td className={cls(v.funding)}>{sgn(v.funding)}</td><td className={cls(net)}>{sgn(net)}</td><td className={cls(net)}>{pct(p)}</td></tr>;
            })}
            {!agg.days.length && <tr><td colSpan={6} className="empty">{loadingInc ? 'Memuat…' : 'Tidak ada transaksi pada rentang ini.'}</td></tr>}
          </tbody>
        </table>
      </div>

      <h4 className="pad label">Per pair</h4>
      <div className="table-wrap">
        <table className="mono">
          <thead><tr><th>Pair</th><th>Trade</th><th>Terealisasi</th><th>Fee</th><th>Funding</th><th>Bersih</th></tr></thead>
          <tbody>
            {agg.syms.map(([s, v]) => {
              const net = v.realized + v.fee + v.funding;
              return <tr key={s}><td>{s ? base(s) : '–'}</td><td>{v.n}</td><td className={cls(v.realized)}>{sgn(v.realized)}</td><td className={cls(v.fee)}>{sgn(v.fee)}</td><td className={cls(v.funding)}>{sgn(v.funding)}</td><td className={cls(net)}>{sgn(net)}</td></tr>;
            })}
            {!agg.syms.length && <tr><td colSpan={6} className="empty">Tidak ada data.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="fine pad">Data langsung dari akun Binance (income: PnL terealisasi, fee, funding). Transfer/deposit tidak dihitung sebagai profit, tapi dipakai untuk menghitung saldo awal. Persen adalah perkiraan dari saldo awal periode. Binance hanya menyimpan ±{inc?.api_limit_days ?? 90} hari; aplikasi menyimpan salinan lokal tiap dibuka{inc?.earliest ? ` (data tersimpan sejak ${new Date(inc.earliest).toLocaleDateString('id-ID')})` : ''}, jadi "Semua" bertambah panjang seiring waktu. Buka tab ini minimal sekali tiap 2 bulan agar tidak ada celah. Hanya baca: aplikasi tidak bisa membuka atau menutup posisi.</p>
    </div>
  );
}
