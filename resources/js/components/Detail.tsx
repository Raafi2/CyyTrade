import { useEffect, useState } from 'react';
import { base, fmtPrice, fmtUsd, sideWord } from '../format';
import type { Analysis } from '../types';

const LABEL: Record<string, string> = {
  htf: 'Tren 4h', setup: 'Tren 1h', momentum: 'Momentum 1h', trigger: 'Trigger 15m',
  structure: 'Struktur harga', flow: 'Aliran volume', futures: 'Posisi futures', btc: 'Konteks BTC',
};

function RiskCalc({ a }: { a: Analysis }) {
  const lv = a.levels!;
  const [bal, setBal] = useState('1000');
  const [risk, setRisk] = useState('1');
  const [lev, setLev] = useState('5');

  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem('rc') ?? 'null') as { bal: string; risk: string; lev: string } | null;
      if (s) { setBal(s.bal); setRisk(s.risk); setLev(s.lev); }
    } catch { /* abaikan */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem('rc', JSON.stringify({ bal, risk, lev })); } catch { /* abaikan */ }
  }, [bal, risk, lev]);

  const B = parseFloat(bal) || 0;
  const R = parseFloat(risk) || 0;
  const L = Math.max(1, parseFloat(lev) || 1);
  const riskAmt = (B * R) / 100;
  const slPct = lv.risk_pct;
  const notional = slPct > 0 ? riskAmt / (slPct / 100) : 0;
  const margin = notional / L;
  const qty = lv.entry > 0 ? notional / lv.entry : 0;
  const gain = (target: number) => 0.5 * notional * (Math.abs(target - lv.entry) / lv.entry);
  const liqPct = 100 / L;

  return (
    <div className="block">
      <h4>Kalkulator risiko</h4>
      <div className="inputs">
        <label>Saldo (USDT)<input inputMode="decimal" value={bal} onChange={(e) => setBal(e.target.value)} /></label>
        <label>Risiko / trade (%)<input inputMode="decimal" value={risk} onChange={(e) => setRisk(e.target.value)} /></label>
        <label>Leverage (x)<input inputMode="decimal" value={lev} onChange={(e) => setLev(e.target.value)} /></label>
      </div>
      <dl className="kv mono">
        <dt>Rugi jika kena SL</dt><dd className="short">-{fmtUsd(riskAmt)}</dd>
        <dt>Ukuran posisi</dt><dd>{fmtUsd(notional)} USDT</dd>
        <dt>Kuantitas</dt><dd>{qty.toPrecision(4)} {base(a.symbol)}</dd>
        <dt>Margin dibutuhkan</dt><dd>{fmtUsd(margin)} USDT</dd>
        <dt>Laba TP1 (50% posisi)</dt><dd className="long">+{fmtUsd(gain(lv.tp1))}</dd>
        <dt>Laba TP2 (50% sisa)</dt><dd className="long">+{fmtUsd(gain(lv.tp2))}</dd>
      </dl>
      {margin > B && <p className="note-bad">Margin melebihi saldo. Naikkan leverage atau turunkan risiko.</p>}
      {slPct > 0.7 * liqPct && (
        <p className="note-bad">Jarak SL ({slPct}%) terlalu dekat dengan perkiraan likuidasi pada {L}x (~{liqPct.toFixed(1)}%). Turunkan leverage.</p>
      )}
      <p className="fine">Perkiraan kasar, belum termasuk biaya, funding, dan slippage.</p>
    </div>
  );
}

export default function Detail({ a }: { a: Analysis | null }) {
  if (!a) return <section className="panel detail"><div className="empty">Pilih pair dari watchlist.</div></section>;

  const active = a.side !== 'NEUTRAL';
  const cls = a.lean === 'LONG' ? 'long' : a.lean === 'SHORT' ? 'short' : 'dim';
  const lv = a.levels;
  const time = new Date(a.generated_at * 1000).toLocaleTimeString('id-ID');

  return (
    <section className="panel detail">
      <div className="panel-head">
        <span className="label">{base(a.symbol)} · Analisis</span>
        <span className="mono dim small">{time}</span>
      </div>

      <div className="verdict">
        {active ? (
          <>
            <div className={`big ${cls}`}>{a.side}</div>
            <div className="sub">Condong {sideWord(a.side)} · confidence <b className="mono">{a.confidence}</b> ({a.tier})</div>
          </>
        ) : a.lean !== 'NEUTRAL' ? (
          <>
            <div className={`big ${cls} hold`}>TAHAN</div>
            <div className="sub">Arah condong {sideWord(a.lean)}, tetapi belum layak entry.</div>
          </>
        ) : (
          <>
            <div className="big dim">NETRAL</div>
            <div className="sub">Tidak ada setup yang jelas.</div>
          </>
        )}
        {a.regime && (
          <div className="chips mono">
            <span>{a.regime.trend}</span><span>ADX {a.regime.adx}</span><span>Vol {a.regime.vol}</span><span>ATR {a.regime.atr_pct}%</span>
          </div>
        )}
      </div>

      {(a.vetoes.length > 0 || a.notes.length > 0) && (
        <div className="block alert">
          <h4>{a.vetoes.length ? 'Alasan ditahan' : 'Catatan'}</h4>
          <ul>{[...a.vetoes, ...a.notes].map((v) => <li key={v}>{v}</li>)}</ul>
        </div>
      )}

      {lv && a.lean !== 'NEUTRAL' && (
        <div className={`block${active ? '' : ' faded'}`}>
          <h4>{active ? 'Level' : 'Level referensi (tidak direkomendasikan)'}</h4>
          <dl className="kv mono">
            <dt>Entry</dt><dd>{fmtPrice(lv.entry)}</dd>
            <dt>Stop loss</dt><dd className="short">{fmtPrice(lv.sl)} <i>({lv.risk_pct}%)</i></dd>
            <dt>TP1</dt><dd className="long">{fmtPrice(lv.tp1)} <i>(1:{lv.rr1})</i></dd>
            <dt>TP2</dt><dd className="long">{fmtPrice(lv.tp2)} <i>(1:{lv.rr2})</i></dd>
          </dl>
          <p className="fine">Rencana: tutup 50% di TP1, geser SL ke entry, sisanya ke TP2.</p>
        </div>
      )}

      {a.reasons.length > 0 && active && (
        <div className="block">
          <h4>Alasan utama</h4>
          <ul>{a.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}

      {a.warnings.length > 0 && (
        <div className="block warn">
          <h4>Peringatan</h4>
          <ul>{a.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      )}

      <div className="block">
        <h4>Rincian skor <span className="dim">bias {a.bias > 0 ? '+' : ''}{a.bias}</span></h4>
        <div className="factors">
          {Object.entries(a.factors).map(([k, f]) => (
            <div className="frow" key={k} title={f.note}>
              <span className="fname">{LABEL[k] ?? k}</span>
              <span className="fbar">
                <i className="mid" />
                <u className={f.s >= 0 ? 'bg-long' : 'bg-short'} style={f.s >= 0 ? { left: '50%', width: `${f.s * 50}%` } : { right: '50%', width: `${-f.s * 50}%` }} />
              </span>
              <span className="mono fval">{f.s > 0 ? '+' : ''}{f.s.toFixed(2)}</span>
              <span className="mono fw">{f.w_pct}%</span>
              <span className="fnote">{f.note}</span>
            </div>
          ))}
        </div>
      </div>

      {active && lv && <RiskCalc a={a} />}

      <p className="fine pad">Skor adalah kekuatan relatif sinyal, bukan probabilitas menang. Bukan nasihat keuangan.</p>
    </section>
  );
}
