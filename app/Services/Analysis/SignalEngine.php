<?php

namespace App\Services\Analysis;

use App\Services\Analysis\Indicators as I;

/**
 * Engine analisis sinyal futures (bebas framework, mudah di-backtest).
 *
 * Alur: regime -> faktor skor [-1..+1] per kategori -> bias berbobot ->
 * veto keras -> confidence -> level entry/SL/TP.
 * Candle yang diberikan HARUS candle yang sudah closed. $price = harga terkini.
 */
final class SignalEngine
{
    public function __construct(private array $cfg) {}

    public function analyze(
        string $symbol,
        array $c15,
        array $c1h,
        array $c4h,
        float $price,
        ?array $futures = null,
        ?array $btc1h = null
    ): array {
        $out = $this->blank($symbol, $price);

        if (count($c1h) < 120 || count($c4h) < 60 || count($c15) < 60) {
            $out['vetoes'][] = 'Data candle belum cukup untuk analisis.';
            return $out;
        }

        // ---------- Seri 1h ----------
        $cl = array_column($c1h, 'c');
        $hi = array_column($c1h, 'h');
        $lo = array_column($c1h, 'l');
        $op = array_column($c1h, 'o');
        $vo = array_column($c1h, 'v');
        $e20 = I::ema($cl, 20);
        $e50 = I::ema($cl, 50);
        $rsi = I::rsi($cl, 14);
        [, , $mh] = I::macd($cl);
        $atrS = I::atr($hi, $lo, $cl, 14);
        [$adxS, $pdi, $mdi] = I::adx($hi, $lo, $cl, 14);
        $atr = I::last($atrS);
        $adx = I::last($adxS) ?? 0.0;
        if (!$atr || $atr <= 0) {
            $out['vetoes'][] = 'ATR tidak valid.';
            return $out;
        }
        $atrPctS = [];
        foreach ($atrS as $i => $a) {
            $atrPctS[] = $a === null ? null : $a / $cl[$i] * 100;
        }
        $volRank = I::percentRank($atrPctS, 100);
        $atrPct = $atr / $price * 100;

        // ---------- Regime ----------
        $trend = $adx >= $this->cfg['regime']['adx_trend'] ? 'TREND'
            : ($adx < $this->cfg['regime']['adx_range'] ? 'RANGE' : 'TRANSISI');
        $volState = $volRank >= 0.97 ? 'EKSTREM' : ($volRank >= 0.85 ? 'TINGGI' : 'NORMAL');
        $out['regime'] = ['trend' => $trend, 'adx' => round($adx, 1), 'vol' => $volState, 'atr_pct' => round($atrPct, 2)];

        // ---------- Struktur 1h ----------
        $sw = I::swings($hi, $lo, 3, 3);
        $swH = $sw['highs'];
        $swL = $sw['lows'];

        // ---------- Faktor ----------
        $f = [];
        $f['htf'] = $this->fHtf($c4h);
        $f['setup'] = $this->fSetup($cl, $e20, $e50, $mh, $atr);
        $f['momentum'] = $this->fMomentum($trend, $rsi, $mh, $atr, $cl, $swH, $swL);
        $f['trigger'] = $this->fTrigger($c15);
        $f['structure'] = $this->fStructure($price, $cl, $swH, $swL, $atr);
        $f['flow'] = $this->fFlow($cl, $op, $vo);
        if ($futures) {
            $f['futures'] = $this->fFutures($futures, $cl, $atrPct);
        }
        if ($btc1h && $symbol !== 'BTCUSDT' && count($btc1h) > 60) {
            $f['btc'] = $this->fBtc($btc1h, $cl);
        }
        $f = array_filter($f, fn ($x) => $x !== null);

        // ---------- Bias berbobot (disesuaikan regime) ----------
        $mult = $this->cfg['regime_mult'][$trend] ?? [];
        $sumW = 0.0;
        $sumWS = 0.0;
        foreach ($f as $k => &$fac) {
            $w = ($this->cfg['weights'][$k] ?? 0.0) * ($mult[$k] ?? 1.0);
            $fac['w'] = $w;
            $sumW += $w;
            $sumWS += $w * $fac['s'];
        }
        unset($fac);
        $bias = $sumW > 0 ? $sumWS / $sumW : 0.0;
        $thr = $this->cfg['bias_threshold'];
        $lean = $bias >= $thr ? 'LONG' : ($bias <= -$thr ? 'SHORT' : 'NEUTRAL');
        $dir = $bias >= 0 ? 1 : -1;

        foreach ($f as $k => &$fac) {
            $fac['w_pct'] = $sumW > 0 ? round($fac['w'] / $sumW * 100, 1) : 0;
            $fac['s'] = round($fac['s'], 3);
            unset($fac['w']);
        }
        unset($fac);
        $out['factors'] = $f;
        $out['bias'] = (int) round($bias * 100);
        $out['lean'] = $lean;

        if ($lean === 'NEUTRAL') {
            $out['notes'][] = 'Faktor-faktor tidak cukup searah. Tidak ada setup yang jelas.';
            return $out;
        }

        // ---------- Level (entry / SL / TP) ----------
        $levels = $this->levels($lean, $price, $atr, $swH, $swL);
        $out['levels'] = $levels;

        // ---------- Veto keras ----------
        $v = [];
        $htfS = $f['htf']['s'] ?? 0;
        $adx4 = $this->adx4h($c4h);
        if ($adx4 >= 25 && $htfS * $dir < 0 && abs($htfS) >= 0.55) {
            $v[] = 'Melawan tren 4h yang kuat (ADX 4h ' . round($adx4) . ').';
        }
        $ext = ($price - I::last($e20)) / $atr;
        if ($ext * $dir > $this->cfg['veto']['max_extension_atr']) {
            $v[] = 'Harga sudah terlalu jauh dari EMA20 1h (' . round(abs($ext), 1) . ' ATR). Mengejar harga.';
        }
        if ($volState === 'EKSTREM' || ($hi[count($hi) - 1] - $lo[count($lo) - 1]) > 4 * $atr) {
            $v[] = 'Volatilitas ekstrem. Stop loss mudah tersapu.';
        }
        $rangeHi = max(array_slice($hi, -50));
        $rangeLo = min(array_slice($lo, -50));
        $pos = $rangeHi > $rangeLo ? ($price - $rangeLo) / ($rangeHi - $rangeLo) : 0.5;
        if ($trend === 'RANGE' && $pos > 0.35 && $pos < 0.65 && abs($f['structure']['s'] ?? 0) < 0.3) {
            $v[] = 'Harga di tengah range sideways. Tidak ada edge.';
        }
        if ($levels['rr1'] < $this->cfg['veto']['min_rr1']) {
            $v[] = 'R:R ke TP1 hanya 1:' . $levels['rr1'] . ' (ada level penghalang dekat).';
        }

        // ---------- Confidence ----------
        $strength = min(1.0, abs($bias) / 0.55);
        $agreeW = 0.0;
        $totW = 0.0;
        foreach ($f as $fac) {
            if (abs($fac['s']) >= 0.12) {
                $totW += $fac['w_pct'];
                if ($fac['s'] * $dir > 0) {
                    $agreeW += $fac['w_pct'];
                }
            }
        }
        $agree = $totW > 0 ? $agreeW / $totW : 0.0;
        $aligned = 0;
        foreach (['htf', 'setup', 'trigger'] as $k) {
            if (isset($f[$k]) && $f[$k]['s'] * $dir > 0.1) {
                $aligned++;
            }
        }
        $conf = 100 * (0.40 * $strength + 0.35 * $agree + 0.25 * ($aligned / 3));
        $warn = [];
        if ($trend === 'TRANSISI') {
            $conf *= 0.92;
        }
        if ($volState === 'TINGGI') {
            $conf *= 0.92;
        }
        if (isset($f['btc']) && $f['btc']['s'] * $dir < -0.35) {
            $conf *= 0.8;
            $warn[] = 'BTC bergerak berlawanan dengan sinyal ini.';
        }
        if (isset($f['futures']) && $f['futures']['s'] * $dir < -0.35) {
            $conf *= 0.85;
            $warn[] = 'Posisi futures (funding/OI/long-short) menunjukkan risiko berlawanan.';
        }
        if (!isset($f['futures'])) {
            $conf *= 0.93;
            $warn[] = 'Data futures (funding/OI) tidak tersedia, confidence dikurangi.';
        }
        $conf = (int) round(min(95, max(0, $conf)));

        $out['confidence'] = $conf;
        $out['tier'] = $conf >= 80 ? 'Sangat kuat' : ($conf >= 70 ? 'Kuat' : ($conf >= 55 ? 'Sedang' : 'Lemah'));
        $out['warnings'] = $warn;
        $out['vetoes'] = $v;
        $out['side'] = ($v === [] && $conf >= $this->cfg['min_confidence']) ? $lean : 'NEUTRAL';
        if ($v === [] && $conf < $this->cfg['min_confidence']) {
            $out['notes'][] = "Confidence {$conf} di bawah ambang {$this->cfg['min_confidence']}. Belum layak entry.";
        }

        // Alasan: kontributor terbesar yang searah arah
        $c = [];
        foreach ($f as $k => $fac) {
            if ($fac['s'] * $dir > 0.15) {
                $c[$k] = $fac['w_pct'] * abs($fac['s']);
            }
        }
        arsort($c);
        foreach (array_slice(array_keys($c), 0, 5) as $k) {
            $out['reasons'][] = $f[$k]['note'];
        }
        return $out;
    }

    // =====================================================================
    // FAKTOR
    // =====================================================================

    private function fHtf(array $c4h): array
    {
        $cl = array_column($c4h, 'c');
        $e50 = I::ema($cl, 50);
        $e200 = I::ema($cl, 200);
        $p = end($cl);
        $a = I::last($e50);
        $b = I::last($e200);
        $prev = I::last($e50, 5);
        $slope = ($a !== null && $prev) ? ($a - $prev) / $prev * 100 : 0;
        $s = 0.25 * $this->sgn($p - $a) + 0.40 * tanh($slope / 1.5);
        $txt = [];
        if ($b !== null) {
            $s += 0.35 * $this->sgn($a - $b);
            $txt[] = 'EMA50 ' . ($a > $b ? 'di atas' : 'di bawah') . ' EMA200';
        } else {
            $s += 0.35 * $this->sgn($slope);
        }
        $txt[] = 'harga ' . ($p > $a ? 'di atas' : 'di bawah') . ' EMA50';
        $adx4 = $this->adx4h($c4h);
        if ($adx4 > 25) {
            $s *= 1.15;
        }
        $s = $this->clamp($s);
        return ['s' => $s, 'note' => '4h: ' . implode(', ', $txt) . ', ADX ' . round($adx4)];
    }

    private function adx4h(array $c4h): float
    {
        [$adx] = I::adx(array_column($c4h, 'h'), array_column($c4h, 'l'), array_column($c4h, 'c'), 14);
        return I::last($adx) ?? 0.0;
    }

    private function fSetup(array $cl, array $e20, array $e50, array $mh, float $atr): array
    {
        $p = end($cl);
        $a = I::last($e20);
        $b = I::last($e50);
        $prev = I::last($e50, 6);
        $slope = $prev ? ($b - $prev) / $prev * 100 : 0;
        $hist = I::last($mh) ?? 0;
        $s = 0.30 * $this->sgn($a - $b) + 0.20 * $this->sgn($p - $b) + 0.30 * tanh($slope / 0.8) + 0.20 * $this->sgn($hist);
        return [
            's' => $this->clamp($s),
            'note' => '1h: EMA20 ' . ($a > $b ? 'di atas' : 'di bawah') . ' EMA50, MACD histogram ' . ($hist >= 0 ? 'positif' : 'negatif'),
        ];
    }

    private function fMomentum(string $trend, array $rsi, array $mh, float $atr, array $cl, array $swH, array $swL): array
    {
        $r = I::last($rsi) ?? 50;
        $tf = ($r - 50) / 20;
        if ($r > 75) {
            $tf = max(0.2, 1 - ($r - 75) / 12);
        } elseif ($r < 25) {
            $tf = min(-0.2, -1 + (25 - $r) / 12);
        }
        $tf = $this->clamp($tf);
        $mr = $this->clamp((50 - $r) / 20);
        $rsiS = match ($trend) {
            'TREND' => $tf,
            'RANGE' => $mr,
            default => 0.5 * $tf + 0.5 * $mr,
        };
        $hist = I::last($mh) ?? 0;
        $histPrev = I::last($mh, 1) ?? 0;
        $macdS = $this->clamp(tanh(($hist / $atr) * 3) * 0.6 + tanh((($hist - $histPrev) / $atr) * 10) * 0.4);

        // Divergence RSI vs harga (2 swing terakhir)
        $div = 0.0;
        $divTxt = '';
        $n = count($cl);
        if (count($swL) >= 2) {
            [$i2, $p2] = $swL[count($swL) - 1];
            [$i1, $p1] = $swL[count($swL) - 2];
            if ($n - $i2 <= 30 && $p2 < $p1 && isset($rsi[$i1], $rsi[$i2]) && $rsi[$i2] > $rsi[$i1] + 2) {
                $div = 0.7;
                $divTxt = ', ada bullish divergence';
            }
        }
        if (count($swH) >= 2) {
            [$i2, $p2] = $swH[count($swH) - 1];
            [$i1, $p1] = $swH[count($swH) - 2];
            if ($n - $i2 <= 30 && $p2 > $p1 && isset($rsi[$i1], $rsi[$i2]) && $rsi[$i2] < $rsi[$i1] - 2) {
                $div = -0.7;
                $divTxt = ', ada bearish divergence';
            }
        }
        $s = $this->clamp(0.45 * $rsiS + 0.35 * $macdS + 0.20 * $div);
        return ['s' => $s, 'note' => 'Momentum 1h: RSI ' . round($r) . ($trend === 'RANGE' ? ' (mode sideways)' : '') . $divTxt];
    }

    private function fTrigger(array $c15): array
    {
        $cl = array_column($c15, 'c');
        $e9 = I::ema($cl, 9);
        $e21 = I::ema($cl, 21);
        $r = I::last(I::rsi($cl, 14)) ?? 50;
        $p = end($cl);
        $s = 0.40 * $this->sgn(I::last($e9) - I::last($e21)) + 0.30 * $this->sgn($p - I::last($e21)) + 0.30 * tanh(($r - 50) / 15);
        if ($r > 82) $s -= 0.4;
        if ($r < 18) $s += 0.4;
        return ['s' => $this->clamp($s), 'note' => '15m: EMA9 ' . (I::last($e9) > I::last($e21) ? 'di atas' : 'di bawah') . ' EMA21, RSI ' . round($r)];
    }

    private function fStructure(float $price, array $cl, array $swH, array $swL, float $atr): array
    {
        $trendS = 0.0;
        $txt = [];
        if (count($swH) >= 2 && count($swL) >= 2) {
            $hh = $swH[count($swH) - 1][1] > $swH[count($swH) - 2][1];
            $hl = $swL[count($swL) - 1][1] > $swL[count($swL) - 2][1];
            $trendS = ((($hh ? 1 : -1) + ($hl ? 1 : -1)) / 2) * 0.7;
            $txt[] = ($hh ? 'HH' : 'LH') . '/' . ($hl ? 'HL' : 'LL');
        }
        $bos = 0.0;
        $lastClose = end($cl);
        if ($swH && $lastClose > end($swH)[1]) {
            $bos = 0.6;
            $txt[] = 'break of structure naik';
        }
        if ($swL && $lastClose < end($swL)[1]) {
            $bos = -0.6;
            $txt[] = 'break of structure turun';
        }
        $prox = 0.0;
        $sup = $this->nearestBelow($swL, $price);
        $res = $this->nearestAbove($swH, $price);
        if ($sup !== null && ($d = ($price - $sup) / $atr) <= 0.8) {
            $prox += 0.5 * (1 - $d / 0.8);
            $txt[] = 'dekat support';
        }
        if ($res !== null && ($d = ($res - $price) / $atr) <= 0.8) {
            $prox -= 0.5 * (1 - $d / 0.8);
            $txt[] = 'dekat resistance';
        }
        $s = $this->clamp(0.45 * $trendS + 0.25 * $bos + 0.30 * $prox);
        return ['s' => $s, 'note' => 'Struktur 1h: ' . ($txt ? implode(', ', $txt) : 'netral')];
    }

    private function fFlow(array $cl, array $op, array $vo): array
    {
        $n = count($cl);
        $avgV = array_sum(array_slice($vo, -21, 20)) / 20;
        if ($avgV <= 0) {
            return ['s' => 0.0, 'note' => 'Volume tidak tersedia'];
        }
        $obv = I::obv($cl, $vo);
        $obvS = $this->clamp((($obv[$n - 1] - $obv[$n - 13]) / (12 * $avgV)) * 3);
        $volS = 0.0;
        for ($k = 1; $k <= 3; $k++) {
            $i = $n - $k;
            $d = $this->sgn($cl[$i] - $op[$i]);
            $vr = $vo[$i] / $avgV;
            $volS += $d * $this->clamp(($vr - 0.8) / 1.2, 0, 1);
        }
        $volS /= 3;
        $lastVr = $vo[$n - 1] / $avgV;
        return [
            's' => $this->clamp(0.55 * $obvS + 0.45 * $volS),
            'note' => 'Aliran volume: OBV ' . ($obvS >= 0 ? 'naik' : 'turun') . ', volume terakhir ' . round($lastVr, 1) . 'x rata-rata',
        ];
    }

    private function fFutures(array $fu, array $cl, float $atrPct): ?array
    {
        $parts = [];
        $txt = [];
        $n = count($cl);

        // Funding (kontrarian hanya di ekstrem)
        if (isset($fu['funding'])) {
            $fr = (float) $fu['funding'];
            $fs = 0.0;
            if ($fr > 0.0001) $fs = -$this->clamp(($fr - 0.0001) / 0.0007, 0, 1);
            if ($fr < -0.0001) $fs = $this->clamp((-$fr - 0.0001) / 0.0005, 0, 1);
            $parts[] = [0.25, $fs];
            $txt[] = 'funding ' . round($fr * 100, 4) . '%';
        }
        // Kuadran harga vs OI (12 jam)
        $oi = $fu['oi'] ?? [];
        if (count($oi) >= 13 && $n >= 13) {
            $pc = ($cl[$n - 1] / $cl[$n - 13] - 1) * 100;
            $oc = ($oi[count($oi) - 1] / $oi[count($oi) - 13] - 1) * 100;
            $pcn = $atrPct > 0 ? $pc / $atrPct : 0;
            $q = 0.0;
            if (abs($pcn) >= 0.5) {
                $mag = 0.5 + 0.5 * min(1, abs($oc) / 4);
                if ($pcn > 0 && $oc > 1) $q = 0.8 * $mag;
                elseif ($pcn > 0 && $oc < -1) $q = -0.2;
                elseif ($pcn < 0 && $oc > 1) $q = -0.8 * $mag;
                elseif ($pcn < 0 && $oc < -1) $q = 0.2;
            }
            $parts[] = [0.30, $q];
            $txt[] = 'harga ' . ($pc >= 0 ? '+' : '') . round($pc, 1) . '% / OI ' . ($oc >= 0 ? '+' : '') . round($oc, 1) . '% (12j)';
        }
        // Rasio akun long/short (kontrarian di ekstrem)
        $ls = $fu['ls'] ?? [];
        if ($ls) {
            $r = (float) end($ls);
            $s = 0.0;
            if ($r > 1.3) $s = -$this->clamp(($r - 1.3) / 1.0, 0, 1);
            elseif ($r < 0.85) $s = $this->clamp((0.85 - $r) / 0.5, 0, 1);
            $parts[] = [0.20, $s];
            $txt[] = 'L/S ' . round($r, 2);
        }
        // Taker buy/sell
        $tk = $fu['taker'] ?? [];
        if (count($tk) >= 6) {
            $r = array_sum(array_slice($tk, -6)) / 6;
            $parts[] = [0.25, $this->clamp(($r - 1) / 0.15)];
            $txt[] = 'taker B/S ' . round($r, 2);
        }
        if (!$parts) {
            return null;
        }
        $w = array_sum(array_column($parts, 0));
        $s = 0.0;
        foreach ($parts as [$pw, $ps]) {
            $s += $pw * $ps;
        }
        return ['s' => $this->clamp($s / $w), 'note' => 'Futures: ' . implode(', ', $txt)];
    }

    private function fBtc(array $btc1h, array $cl): array
    {
        $bc = array_column($btc1h, 'c');
        $e20 = I::ema($bc, 20);
        $e50 = I::ema($bc, 50);
        $prev = I::last($e50, 6);
        $slope = $prev ? (I::last($e50) - $prev) / $prev * 100 : 0;
        $bs = $this->clamp(0.4 * $this->sgn(I::last($e20) - I::last($e50)) + 0.3 * $this->sgn(end($bc) - I::last($e50)) + 0.3 * tanh($slope / 0.6));
        $ret = fn (array $x) => array_map(fn ($i) => log($x[$i] / $x[$i - 1]), range(count($x) - 48, count($x) - 1));
        $corr = I::pearson($ret($cl), $ret($bc));
        return ['s' => $this->clamp($bs * max(0, $corr)), 'note' => 'BTC ' . ($bs >= 0 ? 'naik' : 'turun') . ' (korelasi ' . round($corr, 2) . ')'];
    }

    // =====================================================================
    // LEVEL
    // =====================================================================

    private function levels(string $side, float $price, float $atr, array $swH, array $swL): array
    {
        $long = $side === 'LONG';
        $minD = 1.0 * $atr;
        $maxD = 2.5 * $atr;
        if ($long) {
            $sup = $this->nearestBelow($swL, $price);
            $d = $sup !== null ? ($price - ($sup - 0.3 * $atr)) : 1.5 * $atr;
        } else {
            $res = $this->nearestAbove($swH, $price);
            $d = $res !== null ? (($res + 0.3 * $atr) - $price) : 1.5 * $atr;
        }
        $risk = min($maxD, max($minD, $d));
        $sl = $long ? $price - $risk : $price + $risk;

        $tp1 = $long ? $price + 1.5 * $risk : $price - 1.5 * $risk;
        $tp2 = $long ? $price + 2.5 * $risk : $price - 2.5 * $risk;

        // Cek level penghalang terdekat
        $barrier = $long ? $this->nearestAbove($swH, $price) : $this->nearestBelow($swL, $price);
        $rrBarrier = null;
        if ($barrier !== null) {
            $rrBarrier = abs($barrier - $price) / $risk;
            if ($rrBarrier >= 1.2 && $rrBarrier < 1.5) {
                $tp1 = $long ? $barrier - 0.1 * $atr : $barrier + 0.1 * $atr;
            }
        }
        $rr1 = abs($tp1 - $price) / $risk;
        if ($rrBarrier !== null && $rrBarrier < 1.2) {
            $rr1 = $rrBarrier;
        }
        $rr2 = abs($tp2 - $price) / $risk;
        $dec = $price >= 100 ? 2 : ($price >= 1 ? 4 : 6);
        return [
            'entry' => round($price, $dec),
            'sl' => round($sl, $dec),
            'tp1' => round($tp1, $dec),
            'tp2' => round($tp2, $dec),
            'rr1' => round($rr1, 2),
            'rr2' => round($rr2, 2),
            'risk_pct' => round($risk / $price * 100, 2),
        ];
    }

    private function nearestBelow(array $sw, float $price): ?float
    {
        $best = null;
        foreach ($sw as [, $p]) {
            if ($p < $price && ($best === null || $p > $best)) $best = $p;
        }
        return $best;
    }

    private function nearestAbove(array $sw, float $price): ?float
    {
        $best = null;
        foreach ($sw as [, $p]) {
            if ($p > $price && ($best === null || $p < $best)) $best = $p;
        }
        return $best;
    }

    // =====================================================================
    private function blank(string $symbol, float $price): array
    {
        return [
            'symbol' => $symbol,
            'price' => $price,
            'side' => 'NEUTRAL',
            'lean' => 'NEUTRAL',
            'bias' => 0,
            'confidence' => 0,
            'tier' => '-',
            'regime' => null,
            'levels' => null,
            'factors' => [],
            'reasons' => [],
            'warnings' => [],
            'vetoes' => [],
            'notes' => [],
            'generated_at' => time(),
        ];
    }

    private function sgn(float $x): float
    {
        return $x > 0 ? 1.0 : ($x < 0 ? -1.0 : 0.0);
    }

    private function clamp(float $x, float $lo = -1.0, float $hi = 1.0): float
    {
        return max($lo, min($hi, $x));
    }
}
