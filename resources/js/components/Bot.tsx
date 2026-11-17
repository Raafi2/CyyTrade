import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { getBot, panicBot, saveBotSettings, startBot, stopBot } from '../api';
import { base, fmtPrice, fmtUsd } from '../format';
import type { BotResp, BotSettings } from '../types';

const sgn = (v: number) => `${v >= 0 ? '+' : '-'}${fmtUsd(Math.abs(v))}`;
const cls = (v: number) => (v > 0 ? 'long' : v < 0 ? 'short' : 'dim');
const hm = (t: number) => new Date(t).toLocaleTimeString('id-ID');
const STATUS: Record<string, string> = {
  open: 'berjalan', tp: 'TP', sl: 'SL', time: 'batas waktu', signal: 'sinyal berbalik', panic: 'darurat', manual: 'manual', other: 'lainnya',
};

export default function Bot() {
  const [d, setD] = useState<BotResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<Record<keyof BotSettings, string> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getBot().then((r) => {
      setD(r); setErr(null);
      setForm((f) => f ?? {
        risk_pct: String(r.settings.risk_pct), max_leverage: String(r.settings.max_leverage), target_usd: String(r.settings.target_usd),
        daily_loss_pct: String(r.settings.daily_loss_pct), max_hold_min: String(r.settings.max_hold_min),
      });
    }).catch((e: Error) => setErr(e.message));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 2000);
    return () => clearInterval(t);
  }, [load]);

  if (err && !d) return <div className="banner">Bot tidak bisa dimuat: {err}</div>;
  if (!d || !form) return <div className="empty">Memuat bot…</div>;

  const alive = d.now - d.heartbeat < 8000;
  const bal = d.runtime.balance;
  const pos = d.runtime.position ?? null;
  const riskUsd = bal ? (bal.available * (parseFloat(form.risk_pct) || 0)) / 100 : 0;
  const winRate = (x: { trades: number; wins: number }) => (x.trades ? `${Math.round((x.wins / x.trades) * 100)}%` : '–');

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); if (ok) setMsg(ok); load(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const onStart = () => {
    if (d.live) {
      const ok = window.confirm(
        `Bot akan membuka posisi SUNGGUHAN di akun Binance Anda.\n\nRisiko per trade maks ${form.risk_pct}% saldo (~${fmtUsd(riskUsd)} USDT), leverage maks ${form.max_leverage}x (dihitung bot), batas rugi harian ${form.daily_loss_pct}%.\n\nAnda bisa kehilangan uang. Lanjutkan?`,
      );
      if (!ok) return;
    }
    void act(startBot, 'Bot dimulai. Pastikan terminal "php artisan bot:run" tetap terbuka.');
  };
  const onPanic = () => {
    if (window.confirm('Tutup posisi bot sekarang dan hentikan bot?')) void act(panicBot, 'Perintah darurat dikirim. Proses bot akan menutup posisi pada siklus berikutnya (±2 detik).');
  };
  const onSave = () => void act(() => saveBotSettings({
    risk_pct: parseFloat(form.risk_pct), max_leverage: parseInt(form.max_leverage, 10), target_usd: parseFloat(form.target_usd),
    daily_loss_pct: parseFloat(form.daily_loss_pct), max_hold_min: parseInt(form.max_hold_min, 10),
  }), 'Pengaturan disimpan.');
  const set = (k: keyof BotSettings) => (e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="history botpage">
      <div className="badges">
        <span className={`badge ${d.live ? 'bad' : 'warn'}`}>{d.runtime.testnet ? 'TESTNET' : d.live ? 'LIVE: ORDER SUNGGUHAN' : 'MODE LATIHAN: tanpa order'}</span>
        <span className={`badge ${alive ? 'ok' : 'bad'}`}>{alive ? 'Proses bot berjalan' : 'Proses bot TIDAK berjalan'}</span>
        <span className={`badge ${d.enabled ? 'ok' : 'warn'}`}>{d.enabled ? 'Bot aktif' : 'Bot berhenti'}</span>
      </div>
      {!alive && <div className="banner">Jalankan di terminal lain: <span className="mono">php artisan bot:run</span> dan biarkan terbuka. Tanpa itu bot tidak memantau apa pun. Posisi yang sudah terbuka tetap dijaga SL/TP di Binance.</div>}
      {!d.configured && <div className="banner">API key belum diatur. Isi BINANCE_API_KEY dan BINANCE_API_SECRET (izin Futures trading, tanpa withdraw) di .env.</div>}
      {!d.live && <div className="banner info">Bot belum akan mengirim order karena <span className="mono">BOT_LIVE=true</span> belum diisi di .env. Di mode ini bot hanya mencatat rencana trade-nya di Catatan.</div>}
      {d.runtime.balance_error && <div className="banner">Saldo gagal dibaca: {d.runtime.balance_error}</div>}

      <div className="stats">
        <div className="stat"><span className="label">Saldo tersedia</span><b className="mono">{bal ? fmtUsd(bal.available) : '–'}</b>
          <span className="mono dim">dompet {bal ? fmtUsd(bal.wallet) : '–'} USDT</span></div>
        <div className="stat"><span className="label">Hari ini</span><b className={`mono ${cls(d.today.pnl)}`}>{sgn(d.today.pnl)}</b>
          <span className="mono dim">{d.today.trades} trade · menang {winRate(d.today)}{d.runtime.day_limit ? ` · batas rugi ${fmtUsd(d.runtime.day_limit)}` : ''}</span></div>
        <div className="stat"><span className="label">Total (semua trade bot)</span><b className={`mono ${cls(d.total.pnl)}`}>{sgn(d.total.pnl)}</b>
          <span className="mono dim">{d.total.trades} trade · menang {winRate(d.total)}</span></div>
        <div className="stat"><span className="label">Status</span><b className="mono" style={{ fontSize: 14 }}>{d.runtime.status ?? '–'}</b></div>
      </div>

      <div className="row botctl">
        <button className="btn primary" disabled={busy || d.enabled} onClick={onStart}>Mulai bot</button>
        <button className="btn" disabled={busy || !d.enabled} onClick={() => void act(stopBot, 'Bot berhenti mencari trade baru. Posisi terbuka tetap dipantau sampai selesai.')}>Berhenti</button>
        <button className="btn danger" disabled={busy} onClick={onPanic}>DARURAT: tutup posisi</button>
      </div>
      {msg && <p className="fine pad">{msg}</p>}

      <h4 className="pad label">Posisi saat ini</h4>
      {pos ? (
        <div className="block">
          <h4>{base(pos.symbol)} <span className={pos.side === 'LONG' ? 'long' : 'short'}>{pos.side}</span> {pos.leverage}x
            <span className="dim">{Math.max(0, Math.round((d.now - pos.opened_at) / 60000))} mnt berjalan</span></h4>
          <div className={`big mono ${cls(pos.pnl)}`}>{sgn(pos.pnl)} USDT</div>
          <div className="prog"><i style={{ width: `${Math.max(0, Math.min(100, pos.progress * 100))}%` }} className={pos.progress >= 0 ? 'bg-long' : 'bg-short'} /></div>
          <div className="fine">{pos.progress >= 0 ? `${Math.round(pos.progress * 100)}% menuju TP` : `bergerak melawan ${Math.round(-pos.progress * 100)}% dari jarak TP`}</div>
          <dl className="kv mono">
            <dt>Entry</dt><dd>{fmtPrice(pos.entry)}</dd>
            <dt>Harga sekarang</dt><dd>{fmtPrice(pos.mark)}</dd>
            <dt>Stop loss</dt><dd className="short">{fmtPrice(pos.sl)}{pos.be_done ? ' (sudah di impas)' : ''}</dd>
            <dt>Take profit</dt><dd className="long">{fmtPrice(pos.tp)}</dd>
            <dt>Likuidasi</dt><dd>{pos.liq > 0 ? fmtPrice(pos.liq) : '–'}</dd>
            <dt>Sinyal terbaru</dt><dd>{pos.signal ? `${pos.signal.side === 'NEUTRAL' ? 'netral' : pos.signal.side} (conf ${pos.signal.confidence})` : 'menunggu'}</dd>
          </dl>
          <p className="fine">SL dan TP terpasang di Binance. Bot juga memantau: menutup bila sinyal berbalik atau melewati batas waktu, dan menggeser SL ke impas saat harga setengah jalan ke TP.</p>
        </div>
      ) : <p className="fine pad">Tidak ada posisi. {d.enabled ? 'Bot sedang mencari setup.' : ''}</p>}

      <h4 className="pad label">Pengaturan <span className="dim">(modal otomatis dari saldo)</span></h4>
      <div className="block">
        <div className="inputs two">
          <label>Risiko per trade (% saldo, maks {d.caps.risk_pct})<input inputMode="decimal" value={form.risk_pct} onChange={set('risk_pct')} /></label>
          <label>Leverage maksimal (bot yang menentukan, maks {d.caps.max_leverage})<input inputMode="numeric" value={form.max_leverage} onChange={set('max_leverage')} /></label>
          <label>Target profit per trade (USDT, 0 = dari analisis)<input inputMode="decimal" value={form.target_usd} onChange={set('target_usd')} /></label>
          <label>Batas rugi harian (% saldo, maks {d.caps.daily_loss_pct})<input inputMode="decimal" value={form.daily_loss_pct} onChange={set('daily_loss_pct')} /></label>
          <label>Batas waktu posisi (menit, maks {d.caps.max_hold_min})<input inputMode="numeric" value={form.max_hold_min} onChange={set('max_hold_min')} /></label>
        </div>
        <p className="fine">Dengan saldo {bal ? fmtUsd(bal.available) : '–'} USDT, rugi maksimal per trade sekitar {fmtUsd(riskUsd)} USDT (ditambah fee). Ukuran posisi dan leverage dihitung bot dari jarak SL, dan trade dilewati bila saldo terlalu kecil untuk ukuran minimum pair atau SL terlalu dekat likuidasi.</p>
        <button className="btn" disabled={busy} onClick={onSave}>Simpan pengaturan</button>
      </div>

      <h4 className="pad label">Riwayat trade bot</h4>
      <div className="table-wrap">
        <table className="mono">
          <thead><tr><th>Buka</th><th>Pair</th><th>Arah</th><th>Lev</th><th>Entry</th><th>Keluar</th><th>Status</th><th>PnL bersih</th></tr></thead>
          <tbody>
            {d.trades.map((t) => (
              <tr key={t.id}>
                <td>{new Date(t.opened_at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}</td>
                <td>{base(t.symbol)}</td><td className={t.side === 'LONG' ? 'long' : 'short'}>{t.side}</td><td>{t.leverage}x</td>
                <td>{fmtPrice(t.entry)}</td><td>{t.exit ? fmtPrice(t.exit) : '–'}</td><td>{STATUS[t.status] ?? t.status}</td>
                <td className={t.pnl === null ? 'dim' : cls(t.pnl)}>{t.pnl === null ? '–' : sgn(t.pnl)}</td>
              </tr>
            ))}
            {!d.trades.length && <tr><td colSpan={8} className="empty">Belum ada trade.</td></tr>}
          </tbody>
        </table>
      </div>

      <h4 className="pad label">Catatan bot</h4>
      <div className="log mono pad">
        {d.events.map((e, i) => <div key={i} className={e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warn' : ''}><span className="dim">{hm(e.time)}</span> {e.message}</div>)}
        {!d.events.length && <span className="dim">Belum ada catatan.</span>}
      </div>
      <p className="fine pad">Bot hanya berjalan selama terminal <span className="mono">php artisan bot:run</span> terbuka dan komputer menyala. Tidak ada jaminan profit; hasil trade bisa rugi, termasuk seluruh modal. Mulai dengan nominal kecil.</p>
    </div>
  );
}
