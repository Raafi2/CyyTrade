import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../css/app.css';
import { getAnalysis, getSymbols, getTrack } from './api';
import Chart from './components/Chart';
import Detail from './components/Detail';
import History from './components/History';
import Watchlist from './components/Watchlist';
import { markStream, symbolStreams, useLive, useStreams } from './live';
import { isErr, type Entry, type SignalRow, type SymbolRow } from './types';

// Analisis memakai candle yang di-cache sampai candle berikutnya close, jadi memindai tiap menit murah.
const AUTO_REFRESH_MS = 60 * 1000;

const MODE_LABEL = { live: 'LIVE', polling: 'POLLING', connecting: 'MENYAMBUNG' } as const;
const MODE_HINT = {
  live: 'Harga dan candle datang langsung dari WebSocket Binance.',
  polling: 'WebSocket Binance tidak tersambung (mungkin diblokir). Data diperbarui tiap 10 detik lewat server; mencoba WebSocket lagi di latar belakang.',
  connecting: 'Menyambung ke WebSocket Binance…',
} as const;

function App() {
  const [tab, setTab] = useState<'pasar' | 'riwayat'>('pasar');
  const [symbols, setSymbols] = useState<SymbolRow[]>([]);
  const [results, setResults] = useState<Record<string, Entry>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [onlyActive, setOnlyActive] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [err, setErr] = useState<string | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [open, setOpen] = useState<SignalRow[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const scanId = useRef(0);
  const lastScan = useRef(0);

  const live = useLive();
  useStreams(symbolStreams(symbols.map((s) => s.symbol)));
  useStreams(selected ? [markStream(selected)] : []);

  // Selesaikan sinyal terbuka dari data pasar nyata, dan perbarui daftar sinyal berjalan.
  const track = useCallback(async () => {
    try {
      const t = await getTrack();
      setOpen(t.open);
      if (t.resolved > 0) setNotice(`${t.resolved} sinyal selesai. Lihat hasilnya di tab Riwayat.`);
    } catch { /* tidak kritis, dicoba lagi di siklus berikutnya */ }
  }, []);

  const scan = useCallback(async () => {
    const id = ++scanId.current;
    lastScan.current = Date.now();
    setScanning(true);
    setErr(null);
    try {
      const syms = await getSymbols();
      if (id !== scanId.current) return;
      setSymbols(syms);
      setSelected((cur) => cur ?? (syms.find((s) => s.symbol === 'BTCUSDT') ?? syms[0])?.symbol ?? null);

      const queue = syms.map((s) => s.symbol);
      const total = queue.length;
      let done = 0;
      setProgress({ done, total });

      const run = async (sym: string) => {
        try {
          const a = await getAnalysis(sym);
          if (id === scanId.current) setResults((r) => ({ ...r, [sym]: a }));
        } catch (e) {
          if (id === scanId.current) setResults((r) => ({ ...r, [sym]: { error: (e as Error).message } }));
        }
        done++;
        if (id === scanId.current) setProgress({ done, total });
      };

      // BTC dulu supaya data BTC masuk cache sebelum altcoin dianalisis paralel.
      const btc = queue.indexOf('BTCUSDT');
      if (btc >= 0) await run(queue.splice(btc, 1)[0]);
      const worker = async () => { while (queue.length) await run(queue.shift()!); };
      await Promise.all([worker(), worker(), worker()]);
    } catch (e) {
      if (id === scanId.current) setErr((e as Error).message);
    } finally {
      if (id === scanId.current) { setScanning(false); setUpdated(new Date()); void track(); }
    }
  }, [track]);

  useEffect(() => { void scan(); }, [scan]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') void scan(); }, AUTO_REFRESH_MS);
    // Kembali ke tab setelah lama di latar belakang: segarkan segera.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastScan.current > AUTO_REFRESH_MS) void scan();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [scan]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 12_000);
    return () => clearTimeout(t);
  }, [notice]);

  const sel = selected ? results[selected] : undefined;
  const analysis = sel && !isErr(sel) ? sel : null;
  const failed = Object.values(results).filter(isErr).length;
  const livePrice = selected ? live.ticks[selected]?.price : undefined;

  return (
    <div className="app">
      <header>
        <div className="brand mono">SINYAL<span>/</span>FUTURES</div>
        <nav>
          <button className={tab === 'pasar' ? 'on' : ''} onClick={() => setTab('pasar')}>Pasar</button>
          <button className={tab === 'riwayat' ? 'on' : ''} onClick={() => setTab('riwayat')}>Riwayat</button>
        </nav>
        <div className="spacer" />
        {open.length > 0 && <span className="status mono dim">{open.length} sinyal berjalan</span>}
        <span className="status mono dim">
          {scanning ? `memindai ${progress.done}/${progress.total}` : updated ? `analisis ${updated.toLocaleTimeString('id-ID')}` : ''}
          {!scanning && failed > 0 ? ` · ${failed} gagal` : ''}
        </span>
        <span className={`live ${live.mode}`} title={MODE_HINT[live.mode]}><i />{MODE_LABEL[live.mode]}</span>
        <button className="btn" onClick={() => void scan()} disabled={scanning}>Segarkan</button>
      </header>

      {err && <div className="banner">Gagal mengambil data dari Binance: {err}</div>}
      {notice && <div className="banner info">{notice}</div>}

      {tab === 'pasar' ? (
        <main className="grid">
          <Watchlist rows={symbols} results={results} ticks={live.ticks} selected={selected} onSelect={setSelected} onlyActive={onlyActive} setOnlyActive={setOnlyActive} />
          {selected
            ? <Chart symbol={selected} analysis={analysis} mode={live.mode} epoch={live.epoch} livePrice={livePrice} />
            : <section className="panel chart"><div className="empty">Memuat…</div></section>}
          {sel && isErr(sel)
            ? <section className="panel detail"><div className="banner">Analisis gagal: {sel.error}</div></section>
            : <Detail a={analysis} livePrice={livePrice} mark={selected ? live.marks[selected] : undefined} />}
        </main>
      ) : (
        <History />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
