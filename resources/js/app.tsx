import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../css/app.css';
import { getAnalysis, getSymbols } from './api';
import Chart from './components/Chart';
import Detail from './components/Detail';
import History from './components/History';
import Watchlist from './components/Watchlist';
import { isErr, type Entry, type SymbolRow } from './types';

const AUTO_REFRESH_MS = 3 * 60 * 1000;

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
  const scanId = useRef(0);

  const scan = useCallback(async () => {
    const id = ++scanId.current;
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
      if (id === scanId.current) { setScanning(false); setUpdated(new Date()); }
    }
  }, []);

  useEffect(() => { void scan(); }, [scan]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') void scan(); }, AUTO_REFRESH_MS);
    return () => clearInterval(t);
  }, [scan]);

  const sel = selected ? results[selected] : undefined;
  const analysis = sel && !isErr(sel) ? sel : null;
  const failed = Object.values(results).filter(isErr).length;

  return (
    <div className="app">
      <header>
        <div className="brand mono">SINYAL<span>/</span>FUTURES</div>
        <nav>
          <button className={tab === 'pasar' ? 'on' : ''} onClick={() => setTab('pasar')}>Pasar</button>
          <button className={tab === 'riwayat' ? 'on' : ''} onClick={() => setTab('riwayat')}>Riwayat</button>
        </nav>
        <div className="spacer" />
        <span className="status mono dim">
          {scanning ? `memindai ${progress.done}/${progress.total}` : updated ? `diperbarui ${updated.toLocaleTimeString('id-ID')}` : ''}
          {!scanning && failed > 0 ? ` · ${failed} gagal` : ''}
        </span>
        <button className="btn" onClick={() => void scan()} disabled={scanning}>Segarkan</button>
      </header>

      {err && <div className="banner">Gagal mengambil data dari Binance: {err}</div>}

      {tab === 'pasar' ? (
        <main className="grid">
          <Watchlist rows={symbols} results={results} selected={selected} onSelect={setSelected} onlyActive={onlyActive} setOnlyActive={setOnlyActive} />
          {selected ? <Chart symbol={selected} analysis={analysis} /> : <section className="panel chart"><div className="empty">Memuat…</div></section>}
          {sel && isErr(sel) ? <section className="panel detail"><div className="banner">Analisis gagal: {sel.error}</div></section> : <Detail a={analysis} />}
        </main>
      ) : (
        <History />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
