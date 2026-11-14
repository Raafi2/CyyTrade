<?php

return [
    'binance_base' => env('BINANCE_FAPI_BASE', 'https://fapi.binance.com'),
    'ssl_verify' => env('BINANCE_SSL_VERIFY', true),

    // Jumlah pair teratas (berdasarkan volume 24 jam USDT-M perpetual) dan batas likuiditas minimum
    'watchlist_size' => (int) env('SIGNAL_WATCHLIST', 20),
    'min_quote_volume' => (float) env('SIGNAL_MIN_VOLUME', 100_000_000),
    'cache_ttl' => (int) env('SIGNAL_CACHE_TTL', 90),

    // Sinyal baru dicatat ke riwayat hanya jika side != NEUTRAL; duplikat dalam N jam diabaikan
    'record_dedupe_hours' => 12,
    'track_max_hours' => 48,

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
