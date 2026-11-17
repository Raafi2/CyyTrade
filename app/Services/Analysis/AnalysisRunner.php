<?php

namespace App\Services\Analysis;

use App\Services\Binance\BinanceFuturesClient;

/** Menjalankan analisis satu pair pada preset timeframe (swing/scalp). Dipakai controller dan bot. */
class AnalysisRunner
{
    public function __construct(private BinanceFuturesClient $bn) {}

    /** @return array<string,mixed> */
    public function run(string $symbol, string $mode = 'swing'): array
    {
        $mode = $mode === 'scalp' ? 'scalp' : 'swing';
        $preset = config("signal.modes.$mode");
        $b = $this->bn->bundle($symbol, $mode);
        $btc = $symbol === 'BTCUSDT' ? null : $this->bn->btcCandles($preset['main']);

        $cfg = config('signal');
        $cfg['tf'] = $preset;
        $cfg['cost_pct'] = (float) $cfg['fee_pct'] + (float) $cfg['slippage_pct'];
        if (isset($preset['min_confidence'])) {
            $cfg['min_confidence'] = $preset['min_confidence'];
        }
        if (isset($preset['max_cost_r'])) {
            $cfg['veto']['max_cost_r'] = $preset['max_cost_r'];
        }

        $res = (new SignalEngine($cfg))->analyze($symbol, $b['trig'], $b['main'], $b['htf'], $b['price'], $b['futures'], $btc);

        // Waktu yang ditampilkan adalah waktu harga diambil, bukan waktu komputasi.
        $res['mode'] = $mode;
        $res['price_at'] = $b['price_at'];
        $res['generated_at'] = intdiv($b['price_at'], 1000);
        $res['live'] = ['mark' => $b['mark'], 'funding' => $b['funding'], 'next_funding' => $b['next_funding']];

        return $res;
    }
}
