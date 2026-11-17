<?php

return [
    // Saklar pengaman: tanpa BOT_LIVE=true bot hanya menganalisis dan mencatat rencana, TIDAK mengirim order.
    'live' => (bool) env('BOT_LIVE', false),

    // Zona waktu untuk batas rugi harian.
    'tz' => env('BOT_TZ', 'Asia/Jakarta'),

    // Batas mutlak (tidak bisa dilewati dari UI).
    'caps' => ['risk_pct' => 3.0, 'max_leverage' => 20, 'daily_loss_pct' => 15.0, 'max_hold_min' => 60],

    // Bawaan konservatif.
    'defaults' => [
        'risk_pct' => 2.0,          // risiko maksimal per trade (% saldo)
        'max_leverage' => 10,       // leverage dihitung bot, tidak akan melewati ini
        'target_usd' => 0.30,       // target profit per trade (USDT); 0 = pakai TP dari analisis
        'daily_loss_pct' => 6.0,    // berhenti sehari bila rugi segini (% saldo awal hari)
        'max_hold_min' => 20,       // tutup paksa bila posisi terlalu lama
        'flip_confidence' => 65,    // tutup bila sinyal berbalik dengan confidence segini
        'breakeven_at' => 0.5,      // geser SL ke impas saat harga setengah jalan ke TP
        'max_losses_row' => 3,      // rugi beruntun sebelum jeda 1 jam
        'watchlist_size' => 20,
        'min_balance' => 3.0,       // saldo minimum (USDT) agar bot membuka trade
    ],
];
