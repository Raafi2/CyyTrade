<?php

namespace App\Services\Bot;

/**
 * Keputusan pemantauan aktif untuk satu posisi terbuka. Murni (tanpa I/O) agar bisa diuji.
 * SL/TP di Binance tetap menjadi pengaman utama; keputusan di sini adalah lapisan tambahan.
 */
final class Manager
{
    /**
     * @param array{side:string,entry:float,sl:float,tp:float,opened_at:int,be_done:bool} $t
     * @param array{side:string,confidence:int}|null $signal analisis scalp terbaru (null bila belum ada)
     * @param array{max_hold_min:int,flip_confidence:int,breakeven_at:float} $cfg
     * @return array{action:string,reason?:string,sl?:float}
     */
    public static function decide(array $t, float $mark, int $nowMs, ?array $signal, array $cfg, float $tick): array
    {
        $long = $t['side'] === 'LONG';
        $d = $long ? 1 : -1;
        $tpDist = abs($t['tp'] - $t['entry']);
        $progress = $tpDist > 0 ? ($d * ($mark - $t['entry'])) / $tpDist : 0.0;

        // Cadangan bila order TP/SL di Binance belum terpicu atau hilang.
        if ($d * ($mark - $t['tp']) >= 0) {
            return ['action' => 'close', 'reason' => 'tp'];
        }
        if ($d * ($mark - $t['sl']) <= 0) {
            return ['action' => 'close', 'reason' => 'sl'];
        }
        if ($nowMs - $t['opened_at'] > $cfg['max_hold_min'] * 60_000) {
            return ['action' => 'close', 'reason' => 'time'];
        }
        if ($signal !== null && $signal['side'] !== 'NEUTRAL' && $signal['side'] !== $t['side'] && $signal['confidence'] >= $cfg['flip_confidence']) {
            return ['action' => 'close', 'reason' => 'signal'];
        }
        if (! $t['be_done'] && $progress >= $cfg['breakeven_at']) {
            $be = Sizing::breakevenSl($t['side'], $t['entry'], $tick);
            // Hanya bila SL baru lebih menguntungkan daripada SL lama dan masih di sisi aman dari harga.
            if ($d * ($be - $t['sl']) > 0 && $d * ($mark - $be) > 0) {
                return ['action' => 'breakeven', 'sl' => $be];
            }
        }

        return ['action' => 'hold'];
    }
}
