# Sinyal Futures (Laravel 13 + React TSX)

Analisis sinyal Binance USDT-M Futures yang berjalan **hanya saat web dibuka**. Tanpa VPS, tanpa Docker,
tanpa Telegram, tanpa scheduler, dan tanpa API key (hanya data publik Binance).

Tidak ada simulasi. Semua angka berasal dari data pasar Binance yang nyata.

## Sumber data

| Data | Sumber | Kesegaran |
|---|---|---|
| Harga watchlist | WebSocket Binance (`@miniTicker`) langsung ke browser | real time (diperbarui tiap ~0,4 dtk di UI) |
| Candle chart (termasuk candle berjalan) | WebSocket `@kline_<tf>` + riwayat dari backend | real time |
| Mark price dan funding | WebSocket `@markPrice@1s` | tiap detik |
| Analisis sinyal | Candle closed dari REST, di-cache sampai candle berikutnya close | selalu mengikuti candle terbaru |
| Harga, mark, funding di dalam analisis | REST, diambil baru tiap analisis (cache 3 dtk) | detik |
| OI, long/short, taker ratio | REST `/futures/data/*` | **per jam** (batasan dari Binance), cache 5 menit |
| Hasil sinyal (SL/TP) | Candle 1m nyata sejak sinyal dibuka, plus funding riil | menit |

Jika WebSocket tidak bisa tersambung (mis. diblokir ISP), UI otomatis turun ke polling tiap 10 detik lewat
backend dan terus mencoba WebSocket di latar belakang. Status ditampilkan di header: `LIVE`, `POLLING`, atau `MENYAMBUNG`.

## Batasan yang perlu diketahui

- Sinyal **hanya dianalisis, dicatat, dan diselesaikan saat web dibuka**. Tanpa VPS tidak ada proses latar
  belakang, jadi sinyal yang muncul saat web tertutup tidak akan tercatat. Riwayat bukan rekaman lengkap pasar.
- Ini bukan eksekusi order. Entry diasumsikan terisi di harga sinyal; slippage dan fee dihitung sebagai perkiraan.
- Confidence adalah skor relatif, **bukan** probabilitas menang.
- Statistik baru bermakna setelah puluhan sinyal selesai. Jangan menaikkan ukuran posisi sebelum itu.

## Instalasi (PHP >= 8.3, Composer, Node 20+)

```bash
composer install
npm install
cp .env.example .env
php artisan key:generate
touch database/database.sqlite   # atau pakai MySQL, lihat .env
php artisan migrate
```

## Menjalankan

```bash
# terminal 1 (4 worker supaya pemindaian paralel tidak antre)
PHP_CLI_SERVER_WORKERS=4 php artisan serve
# terminal 2
npm run dev
```

Buka http://127.0.0.1:8000

## Hasil sinyal (tab Riwayat)

Sinyal terbuka diselesaikan memakai **candle 1m nyata** sejak sinyal dibuka (dicek otomatis saat web dibuka dan
tiap menit). Aturan, dari yang paling konservatif:

- SL dan TP1 tersentuh di candle yang sama: dihitung SL.
- TP1 tersentuh lalu harga kembali ke entry di candle yang sama: berhenti di break-even.
- Tutup 50% di TP1, SL digeser ke entry, 50% sisanya menuju TP2. Kedaluwarsa setelah 48 jam (dihitung mark-to-market).
- Hasil **bersih** dalam R: dikurangi fee (0,10% round-trip), slippage (0,04%), dan **funding riil** yang
  terjadi selama posisi terbuka. Angka kotor dan biaya terlihat saat kursor di atas hasil.

## Opsi `.env` (semua opsional)

| Key | Default | Fungsi |
|---|---|---|
| `SIGNAL_WATCHLIST` | 20 | jumlah pair teratas (volume 24j) |
| `SIGNAL_MIN_VOLUME` | 100000000 | volume minimum 24j (USDT) |
| `SIGNAL_LIVE_TTL` | 3 | detik cache harga/mark/funding (hanya meredam request serentak) |
| `SIGNAL_FUTURES_TTL` | 300 | detik cache OI/long-short/taker |
| `SIGNAL_FEE_PCT` | 0.10 | fee round-trip (%) |
| `SIGNAL_SLIPPAGE_PCT` | 0.04 | perkiraan slippage (%) |
| `BINANCE_FAPI_BASE` | https://fapi.binance.com | ganti jika endpoint REST diblokir |
| `VITE_BINANCE_WS` | wss://fstream.binance.com | ganti jika WebSocket diblokir |
| `BINANCE_CA_BUNDLE` | (kosong) | path CA bundle jika ada error SSL |

## Keamanan API

- Hanya simbol USDT-M perpetual yang benar-benar ada di Binance yang dilayani (selain itu 404).
- Rate limit 300 request/menit per IP.
- Jika Binance membalas 429/418, semua request dihentikan sampai waktu yang diminta (`Retry-After`).
- `Cache::lock` mencegah banyak request mengambil data yang sama sekaligus.
- Pesan error mentah tidak dikirim ke klien.

## Cara kerja singkat

1. Regime pasar (TREND/RANGE/TRANSISI via ADX) menentukan bobot faktor.
2. 8 faktor berskor -1..+1: tren 4h, tren 1h, momentum (RSI/MACD/divergence), trigger 15m, struktur harga
   (HH/HL, break of structure, support/resistance), aliran volume, posisi futures (funding, OI vs harga,
   long/short ratio, taker), konteks BTC untuk altcoin.
3. Veto keras: melawan tren 4h kuat, mengejar harga (>2.2 ATR dari EMA20), volatilitas ekstrem,
   tengah range sideways, R:R ke TP1 < 1.2.
4. Confidence = kekuatan bias + kesepakatan faktor + keselarasan multi-timeframe, dengan penalti.
5. SL berbasis swing + ATR (1.0-2.5 ATR), TP1 = 1.5R, TP2 = 2.5R.
6. Di UI, jarak harga live dari entry ditampilkan dalam R, dengan peringatan bila harga sudah mendekati SL
   atau sudah berlari jauh (mengejar).

## Struktur

- `app/Services/Analysis/` Indicators, SignalEngine, SignalResolver (murni PHP, bebas framework)
- `app/Services/Binance/BinanceFuturesClient.php` data publik, cache, lock, backoff
- `app/Services/SignalTracker.php` pencatatan dan penyelesaian sinyal
- `routes/api.php` endpoint `/api/*`
- `resources/js/live.ts` feed WebSocket Binance (reconnect, fallback polling)
- `resources/js/` UI React TSX (watchlist, chart, detail, riwayat)
- `tests/Unit/` tes resolver, indikator, dan engine (`php artisan test`)
