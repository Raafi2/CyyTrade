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

## Tab Scalping

Isi pair, arah, entry, modal (USDT), dan leverage. SL/TP tidak diisi: setelah "Mulai pantau" aplikasi menyarankannya dari
analisis scalp (candle 1m/5m/15m) atau ATR 5m, disesuaikan dengan leverage (SL tidak melewati batas aman likuidasi), lengkap dengan
verdict (searah/netral/berlawanan) dan perkiraan waktu. Boleh diubah manual. Setelah "Mulai pantau":

- Harga tiap trade (`@aggTrade`) dipantau langsung dari WebSocket Binance. TP, SL, atau likuidasi memicu
  notifikasi browser, bunyi, judul tab berkedip, dan getar (di perangkat yang mendukung).
- Candle 1m nyata dicek ulang bila tab sempat tertahan atau koneksi putus, jadi level yang tersentuh saat itu tetap
  terdeteksi (SL dan TP di candle yang sama dihitung SL).
- Peringatan dini bila harga tinggal 25% jarak ke SL, dan bila sinyal scalp berbalik melawan posisi.
- Perkiraan waktu dihitung dari volatilitas 1m nyata dengan model gerak acak tanpa arah: ini statistik, bukan prediksi.
- PnL bersih memakai fee taker 0,05% per sisi. Harga likuidasi adalah perkiraan isolated (maintenance margin 0,5%).
- Posisi disimpan di `localStorage` browser. Alert hanya jalan selama tab terbuka; tidak ada proses latar belakang.
- Sinyal scalp tidak masuk Riwayat/statistik. Sinyal dengan SL terlalu rapat (fee > 0,25R) ditolak otomatis.

## Tab Portofolio (read-only, opsional)

Membaca akun Binance Futures Anda langsung dari Binance: saldo, posisi terbuka (PnL live dari WebSocket), dan total
profit pada rentang tanggal (hari ini, 7/30 hari, bulan ini, atau kustom, maksimal 92 hari) yang dipecah per hari dan per pair.
Profit bersih = PnL terealisasi + fee + funding; transfer tidak dihitung. Kotak pencarian memfilter posisi dan transaksi per pair.

Pengaturan keamanan:

1. Buat API key baru di Binance dengan **hanya "Enable Reading"**. Jangan aktifkan trading, withdraw, atau transfer.
2. Batasi key ke IP publik Anda (trusted IPs).
3. Isi `BINANCE_API_KEY` dan `BINANCE_API_SECRET` di `.env` (jangan di-commit, jangan ditempel di chat), lalu `php artisan config:clear`.
4. Aplikasi tidak punya login, jadi data akun hanya dilayani ke `127.0.0.1`/`::1`. Jangan buka aplikasi ke jaringan.
   `BINANCE_ACCOUNT_ALLOW_REMOTE=true` mematikan pembatasan ini dan tidak disarankan.

Kunci hanya dipakai di server (tanda tangan HMAC-SHA256), tidak pernah dikirim ke browser. Data profit memakai endpoint
`income` Binance, yang hanya menyimpan sekitar 3 bulan terakhir.

## Pencarian

Watchlist (tab Pasar), tab Riwayat, dan tab Portofolio punya kotak pencarian per pair.

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
| `SIGNAL_WATCHLIST` | 100 | jumlah pair teratas (volume 24j) |
| `SIGNAL_MIN_VOLUME` | 10000000 | volume minimum 24j (USDT) |
| `SIGNAL_LIVE_TTL` | 3 | detik cache harga/mark/funding (hanya meredam request serentak) |
| `SIGNAL_FUTURES_TTL` | 300 | detik cache OI/long-short/taker |
| `SIGNAL_FEE_PCT` | 0.10 | fee round-trip (%) |
| `SIGNAL_SLIPPAGE_PCT` | 0.04 | perkiraan slippage (%) |
| `SIGNAL_SCALP_MAX_COST_R` | 0.25 | batas fee+slippage (dalam R) untuk sinyal scalp |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | (kosong) | API key read-only untuk tab Portofolio |
| `BINANCE_FAPI_BASE` | https://fapi.binance.com | ganti jika endpoint REST diblokir |
| `VITE_BINANCE_WS` | wss://fstream.binance.com | ganti jika WebSocket diblokir |
| `BINANCE_CA_BUNDLE` | (kosong) | path CA bundle jika ada error SSL |

## Keamanan API

- Hanya simbol USDT-M perpetual yang benar-benar ada di Binance yang dilayani (selain itu 404).
- Rate limit 600 request/menit per IP.
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
