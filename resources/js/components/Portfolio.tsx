import { useCallback, useEffect, useMemo, useState } from 'react';
import { getIncome, getPortfolio } from '../api';
import { base, fmtPrice, fmtUsd } from '../format';
import { symbolStreams, useStreams, type LiveSnapshot } from '../live';
import type { IncomeResp, PortResp } from '../types';

const sgn = (v: number) => `${v >= 0 ? '+' : '-'}${fmtUsd(Math.abs(v))}`;
const cls = (v: number) => (v > 0 ? 'long' : v < 0 ? 'short' : 'dim');
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOf = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 0, 0, 0, 0).getTime(); };
const endOf = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 23, 59, 59, 999).getTime(); };

type Preset = 'hari' | '7' | '30' | 'bulan' | 'kustom';

function presetRange(p: Exclude<Preset, 'kustom'>): [string, string] {
  const now = new Date();
  const today = ymd(now);
  if (p === 'hari') return [today, today];
  if (p === 'bulan') return [ymd(new Date(now.getFullYear(), now.getMonth(), 1)), today];
  const back = new Date(now); back.setDate(back.getDate() - (p === '7' ? 6 : 29));
  return [ymd(back), today];
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
    if (!from || !to || startOf(from) > endOf(to)) return;
    setLoadingInc(true);
    getIncome(startOf(from), endOf(to))
      .then((d) => { setInc(d); setIncErr(null); })
      .catch((e: Error) => setIncErr(e.message))
      .finally(() => setLoadingInc(false));
  }, [from, to]);
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

  const records = useMemo(() => (inc?.records ?? []).filter((r) => match(r.symbol)), [inc, needle]); // eslint-disable-line react-hooks/exhaustive-deps

  const agg = useMemo(() => {
    const byDay = new Map<string, { realized: number; fee: number; funding: number }>();
    const bySym = new Map<string, { realized: number; fee: number; funding: number; n: number }>();
    let win = 0; let lose = 0; let realized = 0; let fee = 0; let funding = 0;
    for (const r of records) {
      const day = ymd(new Date(r.time));
      const d = byDay.get(day) ?? { realized: 0, fee: 0, funding: 0 };
      const s = bySym.get(r.symbol) ?? { realized: 0, fee: 0, funding: 0, n: 0 };
      if (r.type === 'REALIZED_PNL') { d.realized += r.income; s.realized += r.income; s.n++; realized += r.income; if (r.income > 0) win++; else if (r.income < 0) lose++; }
      else if (r.type === 'COMMISSION') { d.fee += r.income; s.fee += r.income; fee += r.income; }
      else { d.funding += r.income; s.funding += r.income; funding += r.income; }
      byDay.set(day, d); bySym.set(r.symbol, s);
    }
    const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
    const syms2 = [...bySym.entries()].sort((a, b) => (b[1].realized + b[1].fee + b[1].funding) - (a[1].realized + a[1].fee + a[1].funding));
    return { days, syms: syms2, win, lose, realized, fee, funding, net: realized + fee + funding };
  }, [records]);

  const pickPreset = (p: Preset) => {
    setPreset(p);
    if (p !== 'kustom') setRange(presetRange(p));
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
        <div className="stat"><span className="label">PnL belum terealisasi {needle ? '(terfilter)' : ''}</span><b className={`mono ${cls(unreal)}`}>{sgn(unreal)}</b></div>
        <div className="stat"><span className="label">Saldo margin</span><b className="mono">{fmtUsd(port.margin_balance ?? 0)}</b></div>
        <div className="stat"><span className="label">Tersedia</span><b className="mono">{fmtUsd(port.available ?? 0)}</b></div>
      </div>

      <div className="toolbar">
        <input className="search" placeholder="Cari pair, mis. BTC" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg">
          {([['hari', 'Hari ini'], ['7', '7 hari'], ['30', '30 hari'], ['bulan', 'Bulan ini'], ['kustom', 'Kustom']] as [Preset, string][]).map(([k, l]) => (
            <button key={k} className={preset === k ? 'on' : ''} onClick={() => pickPreset(k)}>{l}</button>
          ))}
        </div>
        <input type="date" value={from} max={to} onChange={(e) => { setPreset('kustom'); setRange([e.target.value, to]); }} />
        <span className="dim">s/d</span>
        <input type="date" value={to} min={from} max={ymd(new Date())} onChange={(e) => { setPreset('kustom'); setRange([from, e.target.value]); }} />
        <button className="btn" onClick={loadInc} disabled={loadingInc}>{loadingInc ? 'Memuat…' : 'Muat'}</button>
      </div>

      <div className="stats">
        <div className="stat"><span className="label">Total profit bersih</span><b className={`mono ${cls(agg.net)}`}>{sgn(agg.net)}</b>
          <span className="mono dim">{from} s/d {to}{needle ? ` · "${q}"` : ''}</span></div>
        <div className="stat"><span className="label">PnL terealisasi</span><b className={`mono ${cls(agg.realized)}`}>{sgn(agg.realized)}</b>
          <span className="mono dim">{agg.win} untung · {agg.lose} rugi</span></div>
        <div className="stat"><span className="label">Fee</span><b className={`mono ${cls(agg.fee)}`}>{sgn(agg.fee)}</b></div>
        <div className="stat"><span className="label">Funding</span><b className={`mono ${cls(agg.funding)}`}>{sgn(agg.funding)}</b></div>
      </div>
      {incErr && <div className="banner">Data profit gagal dimuat: {incErr}</div>}
      {inc?.truncated && <div className="banner">Data sangat banyak dan dipotong. Persempit rentang tanggal.</div>}

      <h4 className="pad label">Posisi terbuka ({positions.length})</h4>
      <div className="table-wrap">
        <table className="mono">
          <thead><tr><th>Pair</th><th>Arah</th><th>Jumlah</th><th>Entry</th><th>Harga</th><th>Likuidasi</th><th>Lev</th><th>PnL</th></tr></thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.symbol}>
                <td>{base(p.symbol)}</td>
                <td className={p.side === 'LONG' ? 'long' : 'short'}>{p.side}</td>
                <td>{p.amt}</td><td>{fmtPrice(p.entry)}</td><td>{fmtPrice(p.px)}</td>
                <td>{p.liq > 0 ? fmtPrice(p.liq) : '–'}</td>
                <td>{p.leverage}x <i className="dim">{p.margin_type}</i></td>
                <td className={cls(p.pnl)}>{sgn(p.pnl)}</td>
              </tr>
            ))}
            {!positions.length && <tr><td colSpan={8} className="empty">{needle ? 'Tidak ada posisi yang cocok.' : 'Tidak ada posisi terbuka.'}</td></tr>}
          </tbody>
        </table>
      </div>

      <h4 className="pad label">Per hari</h4>
      <div className="table-wrap">
        <table className="mono">
          <thead><tr><th>Tanggal</th><th>Terealisasi</th><th>Fee</th><th>Funding</th><th>Bersih</th></tr></thead>
          <tbody>
            {agg.days.map(([d, v]) => {
              const net = v.realized + v.fee + v.funding;
              return <tr key={d}><td>{d}</td><td className={cls(v.realized)}>{sgn(v.realized)}</td><td className={cls(v.fee)}>{sgn(v.fee)}</td><td className={cls(v.funding)}>{sgn(v.funding)}</td><td className={cls(net)}>{sgn(net)}</td></tr>;
            })}
            {!agg.days.length && <tr><td colSpan={5} className="empty">{loadingInc ? 'Memuat…' : 'Tidak ada transaksi pada rentang ini.'}</td></tr>}
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
      <p className="fine pad">Data langsung dari akun Binance (income: PnL terealisasi, fee, funding). Transfer/deposit tidak dihitung sebagai profit. Hanya baca: aplikasi tidak bisa membuka atau menutup posisi.</p>
    </div>
  );
}
