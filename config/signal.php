<?php

return [
    'binance_base' => env('BINANCE_FAPI_BASE', 'https://fapi.binance.com'),
    'ssl_verify' => env('BINANCE_SSL_VERIFY', true),
    // Path CA bundle kustom (opsional). Jika kosong dipakai storage/cacert.pem atau bawaan PHP.
    'ca_bundle' => env('BINANCE_CA_BUNDLE', ''),

    // Jumlah pair teratas (berdasarkan volume 24 jam USDT-M perpetual) dan batas likuiditas minimum
    'watchlist_size' => (int) env('SIGNAL_WATCHLIST', 20),
    'min_quote_volume' => (float) env('SIGNAL_MIN_VOLUME', 100_000_000),

    // Cache data. Candle closed di-cache sampai candle berikutnya close (otomatis).
    // live_ttl: harga/mark/funding, hanya untuk meredam request serentak (detik).
    // futures_ttl: OI, long/short, taker. Dari Binance memang per jam (detik).
    'live_ttl' => (int) env('SIGNAL_LIVE_TTL', 3),
    'futures_ttl' => (int) env('SIGNAL_FUTURES_TTL', 300),

    // Sinyal baru dicatat ke riwayat hanya jika side != NEUTRAL; duplikat dalam N jam diabaikan
    'record_dedupe_hours' => 12,
    'track_max_hours' => 48,

    // Biaya yang dikurangkan dari hasil sinyal (persen dari nilai posisi, round-trip).
    // fee: taker 0.05% x 2. slippage: perkiraan. Funding riil diambil dari Binance.
    'fee_pct' => (float) env('SIGNAL_FEE_PCT', 0.10),
    'slippage_pct' => (float) env('SIGNAL_SLIPPAGE_PCT', 0.04),

    'min_confidence' => 60,
    'bias_threshold' => 0.22,

    'regime' => ['adx_trend' => 25, 'adx_range' => 18],

    'weights' => [
        'htf' => 0.18, 'setup' => 0.14, 'momentum' => 0.12, 'trigger' => 0.08,
        'structure' => 0.16, 'flow' => 0.08, 'futures' => 0.18, 'btc' => 0.06,
    ],
    'regime_mult' => [
        'TREND' => ['htf' => 1.3, 'setup' => 1.2, 'momentum' => 0.9],
        'RANGE' => ['htf' => 0.6, 'setup' => 0.7, 'momentum' => 1.3, 'structure' => 1.3, 'trigger' => 0.9],
        'TRANSISI' => [],
    ],

    'veto' => ['min_rr1' => 1.2, 'max_extension_atr' => 2.2],
];
