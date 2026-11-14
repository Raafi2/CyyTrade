<?php

namespace App\Services\Analysis;

/**
 * Indikator teknikal murni PHP (tanpa dependensi framework).
 * Semua fungsi mengembalikan array sepanjang input; nilai null = belum cukup data.
 */
final class Indicators
{
    public static function sma(array $v, int $p): array
    {
        $n = count($v);
        $out = array_fill(0, $n, null);
        if ($n < $p) {
            return $out;
        }
        $sum = array_sum(array_slice($v, 0, $p));
        $out[$p - 1] = $sum / $p;
        for ($i = $p; $i < $n; $i++) {
            $sum += $v[$i] - $v[$i - $p];
            $out[$i] = $sum / $p;
        }
        return $out;
    }

    public static function ema(array $v, int $p): array
    {
        $n = count($v);
        $out = array_fill(0, $n, null);
        if ($n < $p) {
            return $out;
        }
        $k = 2 / ($p + 1);
        $e = array_sum(array_slice($v, 0, $p)) / $p;
        $out[$p - 1] = $e;
        for ($i = $p; $i < $n; $i++) {
            $e = $v[$i] * $k + $e * (1 - $k);
            $out[$i] = $e;
        }
        return $out;
    }

    /** RSI Wilder */
    public static function rsi(array $c, int $p = 14): array
    {
        $n = count($c);
        $out = array_fill(0, $n, null);
        if ($n <= $p) {
            return $out;
        }
        $g = 0.0;
        $l = 0.0;
        for ($i = 1; $i <= $p; $i++) {
            $d = $c[$i] - $c[$i - 1];
            $d >= 0 ? $g += $d : $l -= $d;
        }
        $ag = $g / $p;
        $al = $l / $p;
        $out[$p] = $al == 0 ? 100.0 : 100 - 100 / (1 + $ag / $al);
        for ($i = $p + 1; $i < $n; $i++) {
            $d = $c[$i] - $c[$i - 1];
            $ag = ($ag * ($p - 1) + max($d, 0)) / $p;
            $al = ($al * ($p - 1) + max(-$d, 0)) / $p;
            $out[$i] = $al == 0 ? 100.0 : 100 - 100 / (1 + $ag / $al);
        }
        return $out;
    }

    /** @return array{0:array,1:array,2:array} [macd, signal, histogram] */
    public static function macd(array $c, int $fast = 12, int $slow = 26, int $sig = 9): array
    {
        $n = count($c);
        $ef = self::ema($c, $fast);
        $es = self::ema($c, $slow);
        $line = array_fill(0, $n, null);
        $first = null;
        for ($i = 0; $i < $n; $i++) {
            if ($ef[$i] !== null && $es[$i] !== null) {
                $line[$i] = $ef[$i] - $es[$i];
                $first ??= $i;
            }
        }
        $signal = array_fill(0, $n, null);
        $hist = array_fill(0, $n, null);
        if ($first !== null) {
            $sub = self::ema(array_slice($line, $first), $sig);
            foreach ($sub as $j => $val) {
                if ($val !== null) {
                    $signal[$first + $j] = $val;
                    $hist[$first + $j] = $line[$first + $j] - $val;
                }
            }
        }
        return [$line, $signal, $hist];
    }

    /** True Range */
    private static function tr(array $h, array $l, array $c): array
    {
        $n = count($c);
        $tr = [$h[0] - $l[0]];
        for ($i = 1; $i < $n; $i++) {
            $tr[$i] = max($h[$i] - $l[$i], abs($h[$i] - $c[$i - 1]), abs($l[$i] - $c[$i - 1]));
        }
        return $tr;
    }

    /** ATR Wilder */
    public static function atr(array $h, array $l, array $c, int $p = 14): array
    {
        $n = count($c);
        $out = array_fill(0, $n, null);
        if ($n <= $p) {
            return $out;
        }
        $tr = self::tr($h, $l, $c);
        $a = array_sum(array_slice($tr, 1, $p)) / $p;
        $out[$p] = $a;
        for ($i = $p + 1; $i < $n; $i++) {
            $a = ($a * ($p - 1) + $tr[$i]) / $p;
            $out[$i] = $a;
        }
        return $out;
    }

    /** @return array{0:array,1:array,2:array} [adx, +DI, -DI] */
    public static function adx(array $h, array $l, array $c, int $p = 14): array
    {
        $n = count($c);
        $adx = array_fill(0, $n, null);
        $pdi = array_fill(0, $n, null);
        $mdi = array_fill(0, $n, null);
        if ($n < 2 * $p + 1) {
            return [$adx, $pdi, $mdi];
        }
        $tr = self::tr($h, $l, $c);
        $pdm = [0.0];
        $mdm = [0.0];
        for ($i = 1; $i < $n; $i++) {
            $up = $h[$i] - $h[$i - 1];
            $dn = $l[$i - 1] - $l[$i];
            $pdm[$i] = ($up > $dn && $up > 0) ? $up : 0.0;
            $mdm[$i] = ($dn > $up && $dn > 0) ? $dn : 0.0;
        }
        $sTr = array_sum(array_slice($tr, 1, $p));
        $sP = array_sum(array_slice($pdm, 1, $p));
        $sM = array_sum(array_slice($mdm, 1, $p));
        $dx = [];
        for ($i = $p; $i < $n; $i++) {
            if ($i > $p) {
                $sTr = $sTr - $sTr / $p + $tr[$i];
                $sP = $sP - $sP / $p + $pdm[$i];
                $sM = $sM - $sM / $p + $mdm[$i];
            }
            $pd = $sTr > 0 ? 100 * $sP / $sTr : 0;
            $md = $sTr > 0 ? 100 * $sM / $sTr : 0;
            $pdi[$i] = $pd;
            $mdi[$i] = $md;
            $dx[$i] = ($pd + $md) > 0 ? 100 * abs($pd - $md) / ($pd + $md) : 0;
        }
        $start = 2 * $p - 1;
        $a = 0.0;
        for ($i = $p; $i <= $start; $i++) {
            $a += $dx[$i];
        }
        $a /= $p;
        $adx[$start] = $a;
        for ($i = $start + 1; $i < $n; $i++) {
            $a = ($a * ($p - 1) + $dx[$i]) / $p;
            $adx[$i] = $a;
        }
        return [$adx, $pdi, $mdi];
    }

    /** @return array{0:array,1:array,2:array,3:array} [upper, mid, lower, widthPct] */
    public static function bollinger(array $c, int $p = 20, float $k = 2.0): array
    {
        $n = count($c);
        $mid = self::sma($c, $p);
        $up = $lo = $w = array_fill(0, $n, null);
        for ($i = $p - 1; $i < $n; $i++) {
            $slice = array_slice($c, $i - $p + 1, $p);
            $sd = self::stdev($slice);
            $up[$i] = $mid[$i] + $k * $sd;
            $lo[$i] = $mid[$i] - $k * $sd;
            $w[$i] = $mid[$i] > 0 ? ($up[$i] - $lo[$i]) / $mid[$i] * 100 : 0;
        }
        return [$up, $mid, $lo, $w];
    }

    public static function stdev(array $v): float
    {
        $n = count($v);
        if ($n < 2) {
            return 0.0;
        }
        $m = array_sum($v) / $n;
        $s = 0.0;
        foreach ($v as $x) {
            $s += ($x - $m) ** 2;
        }
        return sqrt($s / $n);
    }

    public static function obv(array $c, array $v): array
    {
        $out = [0.0];
        for ($i = 1, $n = count($c); $i < $n; $i++) {
            $out[$i] = $out[$i - 1] + ($c[$i] > $c[$i - 1] ? $v[$i] : ($c[$i] < $c[$i - 1] ? -$v[$i] : 0));
        }
        return $out;
    }

    /** Persentil: porsi nilai (dari N terakhir) yang lebih kecil dari nilai terakhir. */
    public static function percentRank(array $series, int $lookback = 100): float
    {
        $vals = array_values(array_filter(array_slice($series, -$lookback), fn ($x) => $x !== null));
        if (count($vals) < 10) {
            return 0.5;
        }
        $cur = end($vals);
        $less = 0;
        foreach ($vals as $x) {
            if ($x < $cur) {
                $less++;
            }
        }
        return $less / count($vals);
    }

    /**
     * Swing high/low terkonfirmasi (fractal).
     * @return array{highs:array<int,array{0:int,1:float}>,lows:array<int,array{0:int,1:float}>}
     */
    public static function swings(array $h, array $l, int $left = 3, int $right = 3): array
    {
        $n = count($h);
        $highs = [];
        $lows = [];
        for ($i = $left; $i < $n - $right; $i++) {
            $isH = true;
            $isL = true;
            for ($j = 1; $j <= $left; $j++) {
                if ($h[$i] <= $h[$i - $j]) $isH = false;
                if ($l[$i] >= $l[$i - $j]) $isL = false;
            }
            for ($j = 1; $j <= $right; $j++) {
                if ($h[$i] < $h[$i + $j]) $isH = false;
                if ($l[$i] > $l[$i + $j]) $isL = false;
            }
            if ($isH) $highs[] = [$i, $h[$i]];
            if ($isL) $lows[] = [$i, $l[$i]];
        }
        return ['highs' => $highs, 'lows' => $lows];
    }

    public static function pearson(array $a, array $b): float
    {
        $n = min(count($a), count($b));
        if ($n < 5) {
            return 0.0;
        }
        $a = array_slice($a, -$n);
        $b = array_slice($b, -$n);
        $ma = array_sum($a) / $n;
        $mb = array_sum($b) / $n;
        $num = $da = $db = 0.0;
        for ($i = 0; $i < $n; $i++) {
            $x = $a[$i] - $ma;
            $y = $b[$i] - $mb;
            $num += $x * $y;
            $da += $x * $x;
            $db += $y * $y;
        }
        return ($da > 0 && $db > 0) ? $num / sqrt($da * $db) : 0.0;
    }

    public static function last(array $a, int $back = 0): ?float
    {
        $v = $a[count($a) - 1 - $back] ?? null;
        return $v === null ? null : (float) $v;
    }
}
