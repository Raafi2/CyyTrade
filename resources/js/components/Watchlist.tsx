import { useMemo } from 'react';
import { base, fmtPct, fmtPrice, sideWord } from '../format';
import type { Tick } from '../live';
import { isErr, type Entry, type SymbolRow } from '../types';

interface Props {
  rows: SymbolRow[];
  results: Record<string, Entry>;
  ticks: Record<string, Tick>;
  selected: string | null;
  onSelect: (s: string) => void;
  onlyActive: boolean;
  setOnlyActive: (v: boolean) => void;
}

export default function Watchlist({ rows, results, ticks, selected, onSelect, onlyActive, setOnlyActive }: Props) {
  const sorted = useMemo(() => {
    const rank = (s: string) => {
      const e = results[s];
      if (!e) return 0;
      if (isErr(e)) return 0;
      const tier = e.side !== 'NEUTRAL' ? 2 : e.lean !== 'NEUTRAL' ? 1 : 0;
      return tier * 1000 + e.confidence;
    };
    return [...rows].sort((a, b) => rank(b.symbol) - rank(a.symbol));
  }, [rows, results]);

  const shown = onlyActive
    ? sorted.filter((r) => { const e = results[r.symbol]; return e && !isErr(e) && e.side !== 'NEUTRAL'; })
    : sorted;

  return (
    <section className="panel watch">
      <div className="panel-head">
        <span className="label">Watchlist</span>
        <label className="check">
          <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
          hanya sinyal aktif
        </label>
      </div>
      <div className="thead">
        <span>Pair</span><span>Arah</span><span className="r">Conf</span><span className="r">24j</span>
      </div>
      <div className="rows">
        {shown.map((r) => {
          const e = results[r.symbol];
          const a = e && !isErr(e) ? e : null;
          const t = ticks[r.symbol];
          const price = t?.price ?? r.price;
          const change = t?.change24h ?? r.change24h;
          return (
            <button key={r.symbol} className={`row${selected === r.symbol ? ' sel' : ''}`} onClick={() => onSelect(r.symbol)}>
              <span className="pair">
                <b>{base(r.symbol)}</b>
                <i className="mono dim">{fmtPrice(price)}</i>
              </span>
              <span className="dir">
                {!e && <span className="dim">memuat…</span>}
                {e && isErr(e) && <span className="short" title={e.error}>gagal</span>}
                {a && a.side !== 'NEUTRAL' && <b className={a.side === 'LONG' ? 'long' : 'short'}>{a.side}</b>}
                {a && a.side === 'NEUTRAL' && a.lean !== 'NEUTRAL' && (
                  <span className="dim"><i className={`dot ${a.lean === 'LONG' ? 'bg-long' : 'bg-short'}`} />condong {sideWord(a.lean)}, ditahan</span>
                )}
                {a && a.side === 'NEUTRAL' && a.lean === 'NEUTRAL' && <span className="dim">tidak ada setup</span>}
              </span>
              <span className="r conf mono">
                {a && a.lean !== 'NEUTRAL' ? a.confidence : '–'}
                {a && a.lean !== 'NEUTRAL' && (
                  <u style={{ width: `${a.confidence}%` }} className={a.side === 'NEUTRAL' ? 'bar-muted' : a.side === 'LONG' ? 'bg-long' : 'bg-short'} />
                )}
              </span>
              <span className={`r mono ${change >= 0 ? 'long' : 'short'}`}>{fmtPct(change, 1)}</span>
            </button>
          );
        })}
        {!shown.length && <div className="empty">{rows.length ? 'Belum ada sinyal aktif.' : 'Memuat daftar pair…'}</div>}
      </div>
    </section>
  );
}
