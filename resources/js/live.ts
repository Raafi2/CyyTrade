import { useEffect, useRef, useSyncExternalStore } from 'react';
import { getSymbols } from './api';

/**
 * Data live langsung dari WebSocket publik Binance Futures ke browser (tanpa server perantara, tanpa API key).
 * Jika WebSocket tidak bisa tersambung (mis. diblokir ISP), otomatis turun ke polling lewat backend
 * dan terus mencoba WebSocket di latar belakang.
 */

export type LiveMode = 'connecting' | 'live' | 'polling';
export interface Tick { price: number; change24h: number; ts: number }
export interface Mark { mark: number; funding: number; nextFunding: number; ts: number }
export interface KlineMsg { time: number; open: number; high: number; low: number; close: number; closed: boolean }

export interface LiveSnapshot {
  mode: LiveMode;
  /** bertambah setiap kali WebSocket (re)connect, supaya chart memuat ulang dan menutup celah data */
  epoch: number;
  ticks: Record<string, Tick>;
  marks: Record<string, Mark>;
}

interface WsMsg {
  e?: string; E?: number; s?: string;
  c?: string; o?: string;                 // miniTicker
  p?: string; r?: string; T?: number;     // markPrice / aggTrade (p = harga)
  k?: { t: number; i: string; o: string; h: string; l: string; c: string; x: boolean };
}

const WS_BASE: string = (import.meta.env.VITE_BINANCE_WS as string | undefined) || 'wss://fstream.binance.com';
const FLUSH_MS = 400;
const CONNECT_TIMEOUT_MS = 8_000;
const POLL_MS = 10_000;
const BATCH = 50;

class Feed {
  private snap: LiveSnapshot = { mode: 'connecting', epoch: 0, ticks: {}, marks: {} };
  private ticks: Record<string, Tick> = {};
  private marks: Record<string, Mark> = {};
  private listeners = new Set<() => void>();

  private ws: WebSocket | null = null;
  private wanted = new Map<string, number>();
  private subscribed = new Set<string>();
  private klineCbs = new Map<string, Set<(k: KlineMsg) => void>>();
  private tickCbs = new Map<string, Set<(price: number, ts: number) => void>>();
  private msgId = 1;
  private fails = 0;
  private started = false;

  private reconnectTimer: number | undefined;
  private connectTimer: number | undefined;
  private syncTimer: number | undefined;
  private flushTimer: number | undefined;
  private pollTimer: number | undefined;

  // ---- store untuk React ----
  getSnapshot = (): LiveSnapshot => this.snap;
  subscribeStore = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  };

  private emit() { this.listeners.forEach((l) => l()); }

  private scheduleFlush() {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = undefined;
      this.snap = { ...this.snap, ticks: { ...this.ticks }, marks: { ...this.marks } };
      this.emit();
    }, FLUSH_MS);
  }

  private setMode(mode: LiveMode, bumpEpoch = false) {
    if (this.snap.mode === mode && !bumpEpoch) return;
    this.snap = { ...this.snap, mode, epoch: this.snap.epoch + (bumpEpoch ? 1 : 0) };
    this.emit();
  }

  // ---- siklus koneksi ----
  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  private connect() {
    window.clearTimeout(this.reconnectTimer);
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${WS_BASE}/ws`);
    } catch {
      this.handleDown();
      return;
    }
    this.ws = ws;
    this.connectTimer = window.setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) ws.close();
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      window.clearTimeout(this.connectTimer);
      this.fails = 0;
      this.stopPolling();
      this.subscribed.clear();
      this.setMode('live', true);
      this.syncSubs();
    };
    ws.onmessage = (ev: MessageEvent<string>) => this.onMessage(ev.data);
    ws.onclose = () => { if (this.ws === ws) this.handleDown(); };
    ws.onerror = () => { /* onclose menyusul */ };
  }

  private handleDown() {
    window.clearTimeout(this.connectTimer);
    this.ws = null;
    this.subscribed.clear();
    this.fails++;
    // Gagal tersambung / terputus: tampilkan data lewat polling sambil terus mencoba WebSocket lagi.
    this.startPolling();
    const delay = this.fails <= 1 ? 1_000 : Math.min(60_000, 2_000 * 2 ** Math.min(this.fails - 2, 5));
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  // ---- polling cadangan ----
  private startPolling() {
    this.setMode('polling');
    if (this.pollTimer !== undefined) return;
    void this.poll();
    this.pollTimer = window.setInterval(() => { if (document.visibilityState === 'visible') void this.poll(); }, POLL_MS);
  }

  private stopPolling() {
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async poll() {
    try {
      const rows = await getSymbols();
      const ts = Date.now();
      for (const r of rows) {
        this.ticks[r.symbol] = { price: r.price, change24h: r.change24h, ts };
        this.emitTick(r.symbol, r.price, ts);
      }
      this.scheduleFlush();
    } catch { /* abaikan, coba lagi di siklus berikutnya */ }
  }

  // ---- langganan stream ----
  want(streams: string[]): () => void {
    for (const s of streams) this.wanted.set(s, (this.wanted.get(s) ?? 0) + 1);
    this.scheduleSync();
    return () => {
      for (const s of streams) {
        const n = (this.wanted.get(s) ?? 0) - 1;
        if (n <= 0) this.wanted.delete(s); else this.wanted.set(s, n);
      }
      this.scheduleSync();
    };
  }

  onKline(stream: string, cb: (k: KlineMsg) => void): () => void {
    const set = this.klineCbs.get(stream) ?? new Set();
    set.add(cb);
    this.klineCbs.set(stream, set);
    return () => { set.delete(cb); };
  }

  /** Callback sinkron di setiap harga masuk (tanpa menunggu flush UI), supaya alert tidak terlambat. */
  onTick(symbol: string, cb: (price: number, ts: number) => void): () => void {
    const key = symbol.toUpperCase();
    const set = this.tickCbs.get(key) ?? new Set();
    set.add(cb);
    this.tickCbs.set(key, set);
    return () => { set.delete(cb); };
  }

  private emitTick(symbol: string, price: number, ts: number) {
    const cbs = this.tickCbs.get(symbol);
    if (cbs && cbs.size) cbs.forEach((cb) => cb(price, ts));
  }

  private scheduleSync() {
    window.clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => this.syncSubs(), 50);
  }

  private syncSubs() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const add = [...this.wanted.keys()].filter((s) => !this.subscribed.has(s));
    const del = [...this.subscribed].filter((s) => !this.wanted.has(s));
    for (let i = 0; i < add.length; i += BATCH) {
      ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: add.slice(i, i + BATCH), id: this.msgId++ }));
    }
    for (let i = 0; i < del.length; i += BATCH) {
      ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: del.slice(i, i + BATCH), id: this.msgId++ }));
    }
    add.forEach((s) => this.subscribed.add(s));
    del.forEach((s) => this.subscribed.delete(s));
  }

  // ---- pesan masuk ----
  private onMessage(raw: string) {
    let d: unknown;
    try { d = JSON.parse(raw); } catch { return; }
    const list = (Array.isArray(d) ? d : [d]) as WsMsg[];
    for (const m of list) this.handle(m);
  }

  private handle(m: WsMsg) {
    if (!m || !m.e || !m.s) return;
    switch (m.e) {
      case '24hrMiniTicker': {
        const c = Number(m.c);
        const o = Number(m.o);
        if (!Number.isFinite(c)) return;
        this.ticks[m.s] = { price: c, change24h: o > 0 ? ((c - o) / o) * 100 : 0, ts: m.E ?? Date.now() };
        this.scheduleFlush();
        this.emitTick(m.s, c, m.E ?? Date.now());
        break;
      }
      case 'aggTrade': {
        const p = Number(m.p);
        if (Number.isFinite(p)) this.emitTick(m.s, p, m.T ?? Date.now());
        break;
      }
      case 'markPriceUpdate': {
        this.marks[m.s] = { mark: Number(m.p), funding: Number(m.r), nextFunding: Number(m.T), ts: m.E ?? Date.now() };
        this.scheduleFlush();
        break;
      }
      case 'kline': {
        const k = m.k;
        if (!k) return;
        const cbs = this.klineCbs.get(`${m.s.toLowerCase()}@kline_${k.i}`);
        if (!cbs || cbs.size === 0) return;
        const msg: KlineMsg = {
          time: Math.floor(k.t / 1000), open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c), closed: k.x,
        };
        cbs.forEach((cb) => cb(msg));
        break;
      }
    }
  }
}

const feed = new Feed();

/** Snapshot live (mode, harga, mark price/funding). Memulai koneksi saat pertama dipakai. */
export function useLive(): LiveSnapshot {
  useEffect(() => { feed.start(); }, []);
  return useSyncExternalStore(feed.subscribeStore, feed.getSnapshot);
}

/** Berlangganan stream Binance selama komponen terpasang. Nama stream huruf kecil, mis. `btcusdt@miniTicker`. */
export function useStreams(streams: string[]) {
  const key = streams.join(',');
  useEffect(() => (key ? feed.want(key.split(',')) : undefined), [key]);
}

/** Candle berjalan satu pair/timeframe; callback dipanggil di setiap pembaruan dari Binance. */
export function useKline(symbol: string | null, tf: string, cb: (k: KlineMsg) => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    if (!symbol) return undefined;
    const stream = `${symbol.toLowerCase()}@kline_${tf}`;
    const release = feed.want([stream]);
    const off = feed.onKline(stream, (k) => ref.current(k));
    return () => { off(); release(); };
  }, [symbol, tf]);
}

/** Harga tiap trade (`@aggTrade`) untuk satu pair, selama komponen terpasang. Memanggil cb di setiap harga. */
export function useTicks(symbol: string | null, cb: (price: number, ts: number) => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    if (!symbol) return undefined;
    const release = feed.want([aggStream(symbol)]);
    const off = feed.onTick(symbol, (p, t) => ref.current(p, t));
    return () => { off(); release(); };
  }, [symbol]);
}

export const aggStream = (symbol: string): string => `${symbol.toLowerCase()}@aggTrade`;
export const symbolStreams = (symbols: string[]): string[] => symbols.map((s) => `${s.toLowerCase()}@miniTicker`);
export const markStream = (symbol: string): string => `${symbol.toLowerCase()}@markPrice@1s`;
