import { useEffect, useState } from 'react';
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
        Hasil dihitung otomatis dari candle 15m (konservatif: bila SL dan TP tersentuh di candle yang sama dianggap SL).
        Belum termasuk biaya &amp; slippage. Gunakan ini sebagai forward-test sebelum menaikkan ukuran posisi.
      </p>
      <div className="table-wrap">
        <table className="mono">
          <thead>
            <tr><th>Waktu</th><th>Pair</th><th>Arah</th><th>Conf</th><th>Entry</th><th>SL</th><th>TP1</th><th>TP2</th><th>Status</th><th>R</th></tr>
          </thead>
          <tbody>
            {d.signals.map((s) => (
              <tr key={s.id}>
                <td>{new Date(s.opened_at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}</td>
                <td>{base(s.symbol)}</td>
                <td className={s.side === 'LONG' ? 'long' : 'short'}>{s.side}</td>
                <td>{s.confidence}</td>
                <td>{fmtPrice(s.entry)}</td><td>{fmtPrice(s.sl)}</td><td>{fmtPrice(s.tp1)}</td><td>{fmtPrice(s.tp2)}</td>
                <td>{STATUS[s.status]}</td>
                <td className={s.r_result === null ? 'dim' : s.r_result >= 0 ? 'long' : 'short'}>
                  {s.r_result === null ? '–' : `${s.r_result > 0 ? '+' : ''}${s.r_result}R`}
                </td>
              </tr>
            ))}
            {!d.signals.length && <tr><td colSpan={10} className="empty">Belum ada sinyal tercatat. Buka tab Pasar dulu.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
