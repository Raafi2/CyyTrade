<?php

namespace App\Services\Bot;

/**
 * Perhitungan ukuran posisi, leverage, SL, dan TP untuk bot. Murni (tanpa I/O) agar mudah diuji.
 *
 * Prinsip: risiko per trade dibatasi persentase saldo, leverage mengikuti kebutuhan (bukan dipilih tinggi),
 * dan trade ditolak bila saldo terlalu kecil, SL terlalu dekat likuidasi, atau target tidak realistis.
 */
final class Sizing
{
    public const FEE_SIDE = 0.0005;   // taker 0,05% per sisi
    public const MMR = 0.005;         // maintenance margin perkiraan
    public const MARGIN_FRAC = 0.6;   // maksimal 60% saldo dipakai sebagai margin
    public const HARD_RISK_PCT = 3.0; // batas mutlak risiko per trade (% saldo)

    public static function decimals(float $step): int
    {
        $s = rtrim(rtrim(sprintf('%.12f', $step), '0'), '.');
        $pos = strpos($s, '.');

        return $pos === false ? 0 : strlen($s) - $pos - 1;
    }

    public static function floorTo(float $v, float $step): float
    {
        return round(floor($v / $step + 1e-9) * $step, self::decimals($step));
    }

    public static function ceilTo(float $v, float $step): float
    {
        return round(ceil($v / $step - 1e-9) * $step, self::decimals($step));
    }

    /**
     * @param array{side:string,entry:float,sl:float,tp:?float,balance:float,risk_pct:float,max_leverage:int,target_usd:?float,
     *              rules:array{tick:float,step:float,min_qty:float,min_notional:float}} $p
     * @return array<string,mixed> ['ok'=>true, ...] atau ['ok'=>false,'reason'=>...]
     */
    public static function plan(array $p): array
    {
        $fail = fn (string $why) => ['ok' => false, 'reason' => $why];
        $long = $p['side'] === 'LONG';
        $entry = $p['entry'];
        $rules = $p['rules'];
        $balance = $p['balance'];
        $riskPct = min($p['risk_pct'], self::HARD_RISK_PCT);
        $maxLev = max(1, min(125, $p['max_leverage']));

        if ($balance <= 0 || $entry <= 0) {
            return $fail('Saldo atau harga tidak valid.');
        }
        $slDist = $long ? $entry - $p['sl'] : $p['sl'] - $entry;
        if ($slDist <= 0) {
            return $fail('SL berada di sisi yang salah dari entry.');
        }

        $riskUsd = $balance * $riskPct / 100;
        $maxNotional = $balance * self::MARGIN_FRAC * $maxLev;
        $qty = $riskUsd / $slDist;
        if ($qty * $entry > $maxNotional) {
            $qty = $maxNotional / $entry; // risiko mengecil, bukan leverage membesar
        }
        $qty = self::floorTo($qty, $rules['step']);

        $minQty = max($rules['min_qty'], self::ceilTo($rules['min_notional'] * 1.05 / $entry, $rules['step']));
        if ($qty < $minQty) {
            // Naikkan ke ukuran minimum hanya bila risikonya tetap di bawah batas mutlak dan muat di margin.
            $qty = $minQty;
            if ($qty * $entry > $maxNotional) {
                return $fail('Saldo terlalu kecil untuk ukuran minimum pair ini dengan leverage maksimal bot.');
            }
            if ($qty * $slDist > $balance * self::HARD_RISK_PCT / 100) {
                return $fail('Ukuran minimum pair ini membuat risiko melebihi '.self::HARD_RISK_PCT.'% saldo.');
            }
        }

        $notional = $qty * $entry;
        $leverage = max(1, (int) ceil($notional / ($balance * self::MARGIN_FRAC)));
        if ($leverage > $maxLev) {
            return $fail('Leverage yang dibutuhkan melebihi batas bot.');
        }
        $liqFrac = 1 / $leverage - self::MMR;
        if ($liqFrac <= 0 || $slDist / $entry > 0.5 * $liqFrac) {
            return $fail('SL terlalu dekat dengan harga likuidasi pada leverage ini.');
        }

        $fees = 2 * self::FEE_SIDE * $notional;
        $target = $p['target_usd'] ?? null;
        if ($target !== null && $target > 0) {
            $tpDist = $target / $qty + 2 * self::FEE_SIDE * $entry;
        } elseif ($p['tp'] !== null) {
            $tpDist = $long ? $p['tp'] - $entry : $entry - $p['tp'];
        } else {
            return $fail('Target TP tidak tersedia.');
        }
        if ($tpDist <= 0) {
            return $fail('TP berada di sisi yang salah dari entry.');
        }
        $rr = $tpDist / $slDist;
        if ($rr < 0.8 || $rr > 3.5) {
            return $fail(sprintf('Target tidak realistis terhadap SL (R:R %.2f, diizinkan 0,8 sampai 3,5).', $rr));
        }

        $slP = $long ? self::floorTo($p['sl'], $rules['tick']) : self::ceilTo($p['sl'], $rules['tick']);
        $tpRaw = $long ? $entry + $tpDist : $entry - $tpDist;
        $tpP = $long ? self::floorTo($tpRaw, $rules['tick']) : self::ceilTo($tpRaw, $rules['tick']);

        return [
            'ok' => true,
            'qty' => $qty,
            'leverage' => $leverage,
            'notional' => round($notional, 4),
            'margin' => round($notional / $leverage, 4),
            'sl' => $slP,
            'tp' => $tpP,
            'sl_dist' => $slDist,
            'tp_dist' => $tpDist,
            'rr' => round($rr, 2),
            'loss_usd' => round($qty * $slDist + $fees, 4),
            'gain_usd' => round($qty * $tpDist - $fees, 4),
        ];
    }

    /** Level SL/TP baru bila posisi sudah di profit: geser SL ke entry ditambah biaya (impas). */
    public static function breakevenSl(string $side, float $entry, float $tick): float
    {
        $buf = 2 * self::FEE_SIDE * $entry;

        return $side === 'LONG' ? self::ceilTo($entry + $buf, $tick) : self::floorTo($entry - $buf, $tick);
    }
}
