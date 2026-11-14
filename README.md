# Sinyal Futures (Laravel 13 + MySQL + React TSX)

Analisis sinyal Binance USDT-M Futures yang berjalan **setiap kali web dibuka**. Tanpa Docker, tanpa Telegram,
tanpa scheduler, dan tanpa API key (hanya data publik).

## Instalasi (PHP >= 8.3, Composer, Node 20+, MySQL)

```bash
composer create-project laravel/laravel signal-bot
cd signal-bot
# 1) salin isi folder overlay ini ke root proyek (timpa file yang sama):
#    app/ config/signal.php database/migrations/ resources/ routes/web.php vite.config.js tsconfig.json
# 2) .env -> DB_CONNECTION=mysql, DB_HOST, DB_DATABASE, DB_USERNAME, DB_PASSWORD (buat database kosong dulu)
php artisan migrate
npm i react react-dom lightweight-charts
npm i -D @vitejs/plugin-react typescript @types/react @types/react-dom
```

## Menjalankan

```bash
# terminal 1 (4 worker supaya pemindaian paralel tidak antre)
PHP_CLI_SERVER_WORKERS=4 php artisan serve
# terminal 2
npm run dev
```

Buka http://127.0.0.1:8000

## Backtest (WAJIB sebelum dipakai uang sungguhan)

```bash
php artisan signals:backtest BTCUSDT,ETHUSDT,SOLUSDT --days=120 --step=4 --fee=0.10
```

Menjalankan engine yang sama persis dengan versi live pada data historis, lalu melaporkan win rate, avg R,
profit factor, drawdown, dan performa per tingkat confidence. Faktor futures dan BTC tidak ikut diuji
(data historisnya tidak lengkap di API publik). Bobot ada di `config/signal.php`.

## Opsi `.env` (semua opsional)

| Key | Default | Fungsi |
|---|---|---|
| `SIGNAL_WATCHLIST` | 20 | jumlah pair teratas (volume 24j) |
| `SIGNAL_MIN_VOLUME` | 100000000 | volume minimum 24j (USDT) |
| `SIGNAL_CACHE_TTL` | 90 | detik cache data Binance |
| `BINANCE_FAPI_BASE` | https://fapi.binance.com | ganti jika endpoint diblokir/tidak terjangkau |

## Cara kerja singkat

1. Regime pasar (TREND/RANGE/TRANSISI via ADX) menentukan bobot faktor.
2. 8 faktor berskor -1..+1: tren 4h, tren 1h, momentum (RSI/MACD/divergence), trigger 15m, struktur harga
   (HH/HL, break of structure, support/resistance), aliran volume, posisi futures (funding, OI vs harga,
   long/short ratio, taker), konteks BTC untuk altcoin.
3. Veto keras: melawan tren 4h kuat, mengejar harga (>2.2 ATR dari EMA20), volatilitas ekstrem,
   tengah range sideways, R:R ke TP1 < 1.2.
4. Confidence = kekuatan bias + kesepakatan faktor + keselarasan multi-timeframe, dengan penalti.
   Ini skor relatif, BUKAN probabilitas menang.
5. SL berbasis swing + ATR (1.0-2.5 ATR), TP1 = 1.5R, TP2 = 2.5R. Tutup 50% di TP1, geser SL ke entry.
6. Setiap sinyal aktif dicatat dan diselesaikan otomatis (tab Riwayat) sebagai forward-test.

## Struktur

- `app/Services/Analysis/` Indicators, SignalEngine, TradeSimulator (murni PHP, bebas framework)
- `app/Services/Binance/BinanceFuturesClient.php` data publik + cache
- `app/Services/SignalTracker.php` pencatatan & penyelesaian sinyal
- `app/Console/Commands/BacktestSignals.php` backtest
- `resources/js/` UI React TSX (watchlist, chart, detail, riwayat)
