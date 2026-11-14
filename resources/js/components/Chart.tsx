import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries, ColorType, LineSeries, LineStyle, createChart,
  type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp,
} from 'lightweight-charts';
import { getCandles } from '../api';
import { base, fmtPrice } from '../format';
import { useKline, type KlineMsg, type LiveMode } from '../live';
import type { Analysis, Bar } from '../types';

const TFS = ['1m', '3m', '5m', '15m', '1h', '4h'] as const;
const POLL_CHART_MS = 5_000;
const C = { long: '#35b58a', short: '#e0524a', amber: '#d9a441', blue: '#6c8cd5', muted: '#7a8493', grid: '#151b22', bg: '#0f1318' };

interface LinePoint { time: UTCTimestamp; value: number }

/** EMA dengan seed SMA, sama dengan perhitungan di backend. */
function emaPoints(bars: Bar[], p: number): LinePoint[] {
  const out: LinePoint[] = [];
  if (bars.length < p) return out;
  const k = 2 / (p + 1);
  let e = bars.slice(0, p).reduce((a, b) => a + b.close, 0) / p;
  out.push({ time: bars[p - 1].time as UTCTimestamp, value: e });
  for (let i = p; i < bars.length; i++) {
    e = bars[i].close * k + e * (1 - k);
    out.push({ time: bars[i].time as UTCTimestamp, value: e });
  }
  return out;
}

interface Props {
  symbol: string;
  analysis: Analysis | null;
  mode: LiveMode;
  epoch: number;
  livePrice?: number;
}

export default function Chart({ symbol, analysis, mode, epoch, livePrice }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candle = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const ema20 = useRef<ISeriesApi<'Line'> | null>(null);
  const ema50 = useRef<ISeriesApi<'Line'> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const bars = useRef<Bar[]>([]);
  const fitted = useRef('');
  const [tf, setTf] = useState<(typeof TFS)[number]>('1h');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const c = createChart(host.current, {
      layout: { background: { type: ColorType.Solid, color: C.bg }, textColor: C.muted, fontFamily: 'JetBrains Mono, monospace', fontSize: 11 },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: '#1b222b' },
      timeScale: { borderColor: '#1b222b', timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: '#2a323d' }, horzLine: { color: '#2a323d' } },
      autoSize: true,
    });
    candle.current = c.addSeries(CandlestickSeries, {
      upColor: C.long, downColor: C.short, borderVisible: false, wickUpColor: C.long, wickDownColor: C.short,
    });
    ema20.current = c.addSeries(LineSeries, { color: C.amber, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    ema50.current = c.addSeries(LineSeries, { color: C.blue, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    chart.current = c;
    return () => { c.remove(); chart.current = null; };
  }, []);

  /** full = pasang ulang seluruh data; selain itu hanya candle terakhir (hemat, untuk tick live). */
  const render = useCallback((full: boolean) => {
    const b = bars.current;
    const last = b[b.length - 1];
    if (!candle.current || !last) return;
    const e20 = emaPoints(b, 20);
    const e50 = emaPoints(b, 50);
    if (full) {
      candle.current.setData(b.map((x) => ({ ...x, time: x.time as UTCTimestamp })));
      ema20.current?.setData(e20);
      ema50.current?.setData(e50);
    } else {
      candle.current.update({ ...last, time: last.time as UTCTimestamp });
      if (e20.length) ema20.current?.update(e20[e20.length - 1]);
      if (e50.length) ema50.current?.update(e50[e50.length - 1]);
    }
  }, []);

  // Riwayat candle dari backend (termasuk candle berjalan). Dimuat ulang setiap WebSocket (re)connect
  // supaya tidak ada celah, dan tiap 5 detik bila mode polling.
  useEffect(() => {
    let live = true;
    setErr(null);
    const key = `${symbol}|${tf}`;
    const load = () => getCandles(symbol, tf)
      .then((d) => {
        if (!live) return;
        bars.current = d.candles;
        render(true);
        if (fitted.current !== key) {
          chart.current?.timeScale().fitContent();
          fitted.current = key;
        }
        setErr(null);
      })
      .catch((e: Error) => { if (live) setErr(e.message); });

    void load();
    const t = mode === 'polling'
      ? window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_CHART_MS)
      : undefined;
    return () => { live = false; if (t !== undefined) window.clearInterval(t); };
  }, [symbol, tf, mode, epoch, render]);

  // Candle berjalan dari WebSocket
  const onKline = useCallback((k: KlineMsg) => {
    const b = bars.current;
    const last = b[b.length - 1];
    if (!last || k.time < last.time) return;
    const bar: Bar = { time: k.time, open: k.open, high: k.high, low: k.low, close: k.close };
    if (k.time === last.time) b[b.length - 1] = bar; else b.push(bar);
    render(false);
  }, [render]);
  useKline(mode === 'polling' ? null : symbol, tf, onKline);

  // Garis entry / SL / TP
  useEffect(() => {
    const s = candle.current;
    if (!s) return;
    lines.current.forEach((l) => s.removePriceLine(l));
    lines.current = [];
    const lv = analysis?.levels;
    if (!analysis || !lv || analysis.lean === 'NEUTRAL') return;
    const add = (price: number, color: string, title: string, style = LineStyle.Dashed) =>
      lines.current.push(s.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    const held = analysis.side === 'NEUTRAL' ? ' (ditahan)' : '';
    add(lv.entry, C.amber, `Entry${held}`);
    add(lv.sl, C.short, 'SL');
    add(lv.tp1, C.long, 'TP1');
    add(lv.tp2, C.long, 'TP2', LineStyle.Dotted);
  }, [analysis, symbol, tf]);

  return (
    <section className="panel chart">
      <div className="panel-head">
        <span className="label">{base(symbol)}/USDT Perp</span>
        {livePrice !== undefined && <span className="mono last-price">{fmtPrice(livePrice)}</span>}
        <div className="seg">
          {TFS.map((t) => (
            <button key={t} className={t === tf ? 'on' : ''} onClick={() => setTf(t)}>{t}</button>
          ))}
        </div>
        <span className="legend mono"><i style={{ background: C.amber }} />EMA20 <i style={{ background: C.blue }} />EMA50</span>
      </div>
      <div className="chart-host" ref={host} />
      {err && <div className="banner">Chart gagal dimuat: {err}</div>}
    </section>
  );
}
