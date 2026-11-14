<?php

namespace App\Services\Analysis;

/**
 * Simulasi hasil trade di candle 15m (dipakai tracker riwayat dan backtest).
 *
 * Model: 50% posisi ditutup di TP1, sisa 50% menuju TP2, SL digeser ke entry setelah TP1.
 * Konservatif: bila SL dan TP tersentuh di candle yang sama, dianggap SL lebih dulu.
 * Hasil dalam satuan R (1R = jarak entry ke SL awal). Biaya/slippage TIDAK dimasukkan.
 */
final class TradeSimulator
{
    /**
     * @return array{status:string,r:float,bars:int}|null  null = posisi masih terbuka
     */
    public static function run(string $side, float $entry, float $sl, float $tp1, float $tp2, array $candles, int $maxBars = 192): ?array
    {
        $long = $side === 'LONG';
        $risk = abs($entry - $sl);
        if ($risk <= 0) {
            return null;
        }
        $rr1 = abs($tp1 - $entry) / $risk;
        $rr2 = abs($tp2 - $entry) / $risk;
        $tp1Hit = false;
        $stop = $sl;

        foreach ($candles as $i => $c) {
            $hitStop = $long ? $c['l'] <= $stop : $c['h'] >= $stop;
            if ($hitStop) {
                return $tp1Hit
                    ? ['status' => 'tp1', 'r' => round(0.5 * $rr1, 2), 'bars' => $i + 1]
                    : ['status' => 'sl', 'r' => -1.0, 'bars' => $i + 1];
            }
            if (!$tp1Hit && ($long ? $c['h'] >= $tp1 : $c['l'] <= $tp1)) {
                $tp1Hit = true;
                $stop = $entry;
            }
            if ($tp1Hit && ($long ? $c['h'] >= $tp2 : $c['l'] <= $tp2)) {
                return ['status' => 'tp2', 'r' => round(0.5 * $rr1 + 0.5 * $rr2, 2), 'bars' => $i + 1];
            }
            if ($i + 1 >= $maxBars) {
                $mtm = ($long ? $c['c'] - $entry : $entry - $c['c']) / $risk;
                $r = $tp1Hit ? 0.5 * $rr1 + 0.5 * $mtm : $mtm;
                return ['status' => 'expired', 'r' => round($r, 2), 'bars' => $i + 1];
            }
        }
        return null;
    }
}
