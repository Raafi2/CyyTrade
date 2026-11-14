<?php

namespace App\Services\Analysis;

/**
 * Menentukan hasil sebuah sinyal dari candle 1m NYATA Binance sejak sinyal dibuka.
 * Tidak ada data buatan: hanya membaca urutan harga yang benar-benar terjadi.
 *
 * Rencana trade: 50% ditutup di TP1, SL digeser ke entry, 50% sisanya menuju TP2.
 * Hasil dalam R (1R = jarak entry ke SL awal), sebelum biaya.
 *
 * Urutan harga di dalam satu candle 1m tidak diketahui, jadi bila ambigu dipakai asumsi terburuk:
 *  - SL dan TP1 tersentuh di candle yang sama  -> SL.
 *  - TP1 tersentuh dan harga juga kembali ke entry di candle yang sama -> berhenti di break-even (TP1).
 *  - Entry diasumsikan terisi di harga sinyal; candle menit pembukaan tidak dihitung.
 */
final class SignalResolver
{
    /**
     * @param  list<array{t:int,h:float,l:float,c:float,ct:int}>  $candles  candle 1m berurutan, sudah closed
     * @return array{status:string,r:float,bars:int,closed_ms:int}|null  null = posisi masih terbuka
     */
    public static function run(string $side, float $entry, float $sl, float $tp1, float $tp2, array $candles, int $maxBars): ?array
    {
        $long = $side === 'LONG';
        $risk = abs($entry - $sl);
        if ($risk <= 0) {
            return null;
        }
        $rr1 = abs($tp1 - $entry) / $risk;
        $rr2 = abs($tp2 - $entry) / $risk;
        $tp1Hit = false;

        foreach ($candles as $i => $c) {
            $bars = $i + 1;
            $stop = fn (float $level): bool => $long ? $c['l'] <= $level : $c['h'] >= $level;
            $target = fn (float $level): bool => $long ? $c['h'] >= $level : $c['l'] <= $level;

            if (! $tp1Hit) {
                if ($stop($sl)) {
                    return self::done('sl', -1.0, $bars, $c);
                }
                if ($target($tp1)) {
                    $tp1Hit = true;
                    if ($stop($entry)) {
                        return self::done('tp1', 0.5 * $rr1, $bars, $c);
                    }
                    if ($target($tp2)) {
                        return self::done('tp2', 0.5 * $rr1 + 0.5 * $rr2, $bars, $c);
                    }
                }
            } else {
                if ($stop($entry)) {
                    return self::done('tp1', 0.5 * $rr1, $bars, $c);
                }
                if ($target($tp2)) {
                    return self::done('tp2', 0.5 * $rr1 + 0.5 * $rr2, $bars, $c);
                }
            }

            if ($bars >= $maxBars) {
                $mtm = ($long ? $c['c'] - $entry : $entry - $c['c']) / $risk;

                return self::done('expired', $tp1Hit ? 0.5 * $rr1 + 0.5 * $mtm : $mtm, $bars, $c);
            }
        }

        return null;
    }

    private static function done(string $status, float $r, int $bars, array $c): array
    {
        return ['status' => $status, 'r' => round($r, 2), 'bars' => $bars, 'closed_ms' => $c['ct']];
    }
}
