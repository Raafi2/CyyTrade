import { useEffect, useMemo, useState } from 'react';
import { getHistory } from '../api';
import { base, fmtPrice } from '../format';
import type { HistoryResp, Stat } from '../types';

const STATUS: Record<string, string> = { open: 'berjalan', sl: 'SL', tp1: 'TP1 → BE', tp2: 'TP2', expired: 'kedaluwarsa' };

function StatBox({ label, s }: { label: string; s: Stat }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <b className="mono">{s.n}<i> trade</i></b>
      <span className="mono dim">
        {s.n ? `win ${s.win_rate}% · avg ${s.avg_r}R · PF ${s.profit_factor ?? '∞'}` : 'belum ada data'}
      </span>
    </div>
  );
}

export default function History() {
  const [d, setD] = useState<HistoryResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (d?.signals ?? []).filter((s) => !n || s.symbol.toLowerCase().includes(n));
  }, [d, q]);

  useEffect(() => {
    getHistory().then(setD).catch((e: Error) => setErr(e.message));
  }, []);

  if (err) return <div className="banner">Riwayat gagal dimuat: {err}</div>;
  if (!d) return <div className="empty">Memuat riwayat dan memperbarui hasil sinyal terbuka…</div>;

  return (
    <div className="history">
      <div className="stats">
        <StatBox label="Semua sinyal selesai" s={d.stats.overall} />
        {Object.entries(d.stats.buckets).map(([k, s]) => <StatBox key={k} label={`Confidence ${k}`} s={s} />)}
        <div className="stat"><span className="label">Sedang berjalan</span><b className="mono">{d.stats.open}</b></div>
      </div>
      <p className="fine pad">
        Hasil dihitung dari candle 1m nyata Binance sejak sinyal dibuka, bukan simulasi data buatan. Bila urutan harga dalam
        satu candle tidak pasti, dipakai asumsi terburuk. Angka R sudah bersih: dikurangi fee, slippage, dan funding riil.
        Sinyal hanya dicatat dan diselesaikan saat web ini dibuka, jadi ini bukan eksekusi order sungguhan.
      </p>
      <div className="toolbar"><input className="search" placeholder="Cari pair, mis. BTC" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="table-wrap">
        <table className="mono">
          <thead>
            <tr><th>Waktu</th><th>Pair</th><th>Arah</th><th>Conf</th><th>Entry</th><th>SL</th><th>TP1</th><th>TP2</th><th>Status</th><th>R</th></tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>{new Date(s.opened_at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}</td>
                <td>{base(s.symbol)}</td>
                <td className={s.side === 'LONG' ? 'long' : 'short'}>{s.side}</td>
                <td>{s.confidence}</td>
                <td>{fmtPrice(s.entry)}</td><td>{fmtPrice(s.sl)}</td><td>{fmtPrice(s.tp1)}</td><td>{fmtPrice(s.tp2)}</td>
                <td>{STATUS[s.status]}</td>
                <td
                  className={s.r_result === null ? 'dim' : s.r_result >= 0 ? 'long' : 'short'}
                  title={s.gross_r === null ? undefined : `kotor ${s.gross_r}R, biaya ${s.cost_r ?? 0}R`}
                >
                  {s.r_result === null ? '–' : `${s.r_result > 0 ? '+' : ''}${s.r_result}R`}
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={10} className="empty">{q ? 'Tidak ada sinyal yang cocok.' : 'Belum ada sinyal tercatat. Buka tab Pasar dulu.'}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
