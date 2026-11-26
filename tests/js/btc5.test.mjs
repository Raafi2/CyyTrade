import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tCdf5, probUp, worstCase, assess, DEFAULT_PARAMS, VolEstimator, sigmaPerSec, seedVarPerSec,
  FlowTracker, SignalGate, roundAt, resolveRecord, summarize,
} from '../../resources/js/btc5.ts';

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('tCdf5: titik acuan tabel t (nu=5)', () => {
  near(tCdf5(0), 0.5, 1e-12);
  near(tCdf5(2.015), 0.95, 1e-3);   // persentil 95
  near(tCdf5(-2.015), 0.05, 1e-3);
  near(tCdf5(4.032), 0.995, 1e-3);  // persentil 99.5
  near(tCdf5(1.156) + tCdf5(-1.156), 1, 1e-12);
});

test('probUp: simetri, monotonik, dan menyempit mendekati akhir', () => {
  near(probUp(0, 5, 100), 0.5, 1e-12);
  assert.ok(probUp(10, 5, 100) > probUp(5, 5, 100));
  assert.ok(probUp(-10, 5, 100) < 0.5);
  // gap positif yang sama makin pasti bila waktu sisa makin sedikit
  assert.ok(probUp(10, 5, 10) > probUp(10, 5, 100));
  near(probUp(10, 5, 100) + probUp(-10, 5, 100), 1, 1e-12);
  assert.equal(probUp(1, 5, 0), 1);
  assert.equal(probUp(-1, 5, 0), 0);
  assert.equal(probUp(0, 5, 0), 0.5);
});

test('worstCase: konservatif selalu <= nominal untuk sisi masing-masing', () => {
  for (const gap of [-30, -12, -3, 0, 4, 20]) {
    const w = worstCase(gap, 4.86, 90, 1.5, 0.25);
    assert.ok(w.up <= w.nom + 1e-12);
    assert.ok(w.down <= 1 - w.nom + 1e-12);
  }
});

test('assess: contoh layar (acuan 60746.39, harga 60733.82, sisa 90 dtk, pasar 30/69) = tunggu', () => {
  const r = assess({ s: 60733.82, k: 60746.39, tau: 90, sigmaSec: 8e-5, extraSd: 1.5, market: { up: 0.30, down: 0.69 }, flow: 0 });
  assert.equal(r.action, 'WAIT'); // selisih nominal ada, tetapi tidak cukup setelah memperhitungkan ketidakpastian sigma
  assert.ok(r.pUp > 0.30 && r.pUp < 0.45);
  assert.ok(r.wUp < r.pUp);
});

test('assess: harga pasar jauh dari nilai wajar memicu sinyal', () => {
  // harga 40 USD di atas acuan, sisa 30 dtk, tetapi pasar masih menghargai Naik 60%
  const r = assess({ s: 60800, k: 60760, tau: 30, sigmaSec: 8e-5, extraSd: 1.5, market: { up: 0.60, down: 0.40 }, flow: 0.1 }, DEFAULT_PARAMS);
  assert.equal(r.action, 'BUY_UP');
  assert.equal(r.side, 'UP');
  assert.ok(r.edgeUp >= DEFAULT_PARAMS.minEdge);
  assert.ok(r.evUp > 0);
});

test('assess: terlalu mepet, tekanan order berlawanan, tanpa data', () => {
  const base = { s: 60800, k: 60760, sigmaSec: 8e-5, extraSd: 1.5, market: { up: 0.60, down: 0.40 }, flow: 0 };
  assert.equal(assess({ ...base, tau: 10 }).action, 'TOO_LATE');
  assert.equal(assess({ ...base, tau: 30, flow: -0.9 }).action, 'WAIT');
  assert.equal(assess({ ...base, tau: 30, k: null }).action, 'NO_DATA');
  assert.equal(assess({ ...base, tau: 30, sigmaSec: null }).action, 'NO_DATA');
  assert.equal(assess({ ...base, tau: 30, market: null }).action, 'NO_MARKET');
  assert.equal(assess({ ...base, tau: 0 }).action, 'ENDED');
});

test('assess: sisi longshot (harga pasar sangat murah) diabaikan', () => {
  const r = assess({ s: 60800, k: 60760, tau: 60, sigmaSec: 8e-5, extraSd: 1.5, market: { up: 0.97, down: 0.03 }, flow: 0 });
  assert.notEqual(r.action, 'BUY_DOWN');
});

test('assess: trigger naik bila edge dicapai pada harga tersebut', () => {
  const inp = { s: 60733.82, k: 60746.39, tau: 90, sigmaSec: 8e-5, extraSd: 1.5, market: { up: 0.30, down: 0.69 }, flow: 0 };
  const a = assess(inp);
  assert.ok(a.triggerUp > inp.s);
  const b = assess({ ...inp, s: a.triggerUp + 0.05 });
  assert.equal(b.action, 'BUY_UP');
  assert.ok(a.triggerDown < inp.s + 100);
});

test('VolEstimator + sigmaPerSec', () => {
  const v = new VolEstimator();
  let p = 60000;
  let seed = 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const t0 = 1_700_000_000;
  for (let t = 0; t < 200; t++) { p *= 1 + rnd() * 2e-4; v.push((t0 + t) * 1000, p); }
  const live = v.live(t0 + 199);
  assert.ok(live && live.n >= 40);
  assert.equal(v.live(t0 + 20), null);
  const s = sigmaPerSec(live, null);
  assert.ok(s.sigma > 1e-5 && s.sigma < 1e-3);
  assert.equal(sigmaPerSec(null, null), null);
  assert.equal(sigmaPerSec(null, 1e-9).source, 'seed');
  assert.equal(seedVarPerSec([1, 2, 3]), null);
  const closes = Array.from({ length: 40 }, (_, i) => 60000 * (1 + (i % 2 ? 6e-4 : -6e-4)));
  assert.ok(seedVarPerSec(closes) > 0);
});

test('FlowTracker dan SignalGate', () => {
  const f = new FlowTracker();
  f.pushBook(1000, 9, 1);
  f.pushTrade(1000, 2, true);
  f.pushTrade(1500, 1, false);
  const v = f.value(2000);
  assert.ok(v.book > 0.7 && v.trade > 0 && v.flow > 0);
  assert.equal(f.value(40_000).trade, 0); // trade sudah kedaluwarsa
  const g = new SignalGate();
  assert.equal(g.update('BUY_UP', 100, 3), false);
  assert.equal(g.update('BUY_UP', 102, 3), false);
  assert.equal(g.update('BUY_UP', 103, 3), true);
  assert.equal(g.update('WAIT', 104, 3), false);
  assert.equal(g.update(null, 110, 3), false);
});

test('roundAt: kelipatan 300 detik dan nomor ronde', () => {
  const r = roundAt(1_700_000_123);
  assert.equal(r.start % 300, 0);
  assert.equal(r.end - r.start, 300);
  assert.ok(r.index >= 1 && r.index <= 288);
  const x = roundAt(r.start + 299);
  assert.equal(x.start, r.start);
  assert.equal(roundAt(r.end).index, r.index === 288 ? 1 : r.index + 1);
});

test('resolveRecord dan summarize: PnL hipotetis per $1', () => {
  const base = { start: 0, end: 300, index: 1, k: 100, kExact: true, endPrice: null, outcome: null, win: null, pnl: null };
  const win = resolveRecord({ ...base, signal: { t: 250, side: 'UP', price: 0.4, pFair: 0.55, edge: 0.1 } }, 101);
  near(win.pnl, 1.5, 1e-9); assert.equal(win.win, true);
  const lose = resolveRecord({ ...base, signal: { t: 250, side: 'UP', price: 0.4, pFair: 0.55, edge: 0.1 } }, 99);
  assert.equal(lose.pnl, -1); assert.equal(lose.win, false);
  const tie = resolveRecord({ ...base, signal: { t: 250, side: 'DOWN', price: 0.5, pFair: 0.55, edge: 0.1 } }, 100);
  assert.equal(tie.pnl, 0); assert.equal(tie.win, null);
  const none = resolveRecord({ ...base, signal: null }, 101);
  assert.equal(none.outcome, 'UP'); assert.equal(none.pnl, null);
  const s = summarize([win, lose, tie, none]);
  assert.equal(s.rounds, 4); assert.equal(s.signals, 3); assert.equal(s.decided, 2); assert.equal(s.wins, 1);
  near(s.winRate, 0.5, 1e-9); near(s.pnl, 0.5, 1e-9);
});
