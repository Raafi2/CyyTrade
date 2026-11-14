import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries, ColorType, LineSeries, LineStyle, createChart,
  type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp,
} from 'lightweight-charts';
import { getCandles } from '../api';
import { base } from '../format';
import type { Analysis } from '../types';

const TFS = ['1m', '3m', '5m', '15m', '1h', '4h'] as const;
const C = { long: '#35b58a', short: '#e0524a', amber: '#d9a441', muted: '#7a8493', grid: '#151b22', bg: '#0f1318' };

export default function Chart({ symbol, analysis }: { symbol: string; analysis: Analysis | null }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candle = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const ema20 = useRef<ISeriesApi<'Line'> | null>(null);
  const ema50 = useRef<ISeriesApi<'Line'> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
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
    ema50.current = c.addSeries(LineSeries, { color: '#6c8cd5', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    chart.current = c;
    return () => { c.remove(); chart.current = null; };
  }, []);

  useEffect(() => {
    let live = true;
    setErr(null);
    getCandles(symbol, tf)
      .then((d) => {
        if (!live || !candle.current) return;
        candle.current.setData(d.candles.map((x) => ({ ...x, time: x.time as UTCTimestamp })));
        ema20.current?.setData(d.ema20.map((x) => ({ ...x, time: x.time as UTCTimestamp })));
        ema50.current?.setData(d.ema50.map((x) => ({ ...x, time: x.time as UTCTimestamp })));
        chart.current?.timeScale().fitContent();
      })
      .catch((e: Error) => live && setErr(e.message));
    return () => { live = false; };
  }, [symbol, tf]);

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
        <div className="seg">
          {TFS.map((t) => (
            <button key={t} className={t === tf ? 'on' : ''} onClick={() => setTf(t)}>{t}</button>
          ))}
        </div>
        <span className="legend mono"><i style={{ background: C.amber }} />EMA20 <i style={{ background: '#6c8cd5' }} />EMA50</span>
      </div>
      <div className="chart-host" ref={host} />
      {err && <div className="banner">Chart gagal dimuat: {err}</div>}
    </section>
  );
}
