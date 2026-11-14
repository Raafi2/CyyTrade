<?php

namespace App\Console\Commands;

use App\Services\Analysis\SignalEngine;
use App\Services\Analysis\TradeSimulator;
use App\Services\Binance\BinanceFuturesClient;
use Illuminate\Console\Command;

/**
 * Backtest walk-forward memakai engine & simulator yang SAMA dengan versi live.
 *
 * Batasan (penting dibaca):
 *  - Faktor futures (funding/OI/long-short/taker) dan BTC TIDAK ikut karena data historisnya
 *    tidak tersedia lengkap dari API publik. Yang diuji hanya bagian teknikal (htf, setup,
 *    momentum, trigger, struktur, flow) plus semua veto.
 *  - Bobot tidak dioptimasi pada data ini, jadi hasil ini bukan hasil curve-fitting,
 *    tetapi tetap hanya satu periode pasar. Jangan dianggap jaminan.
 */
class BacktestSignals extends Command
{
    protected $signature = 'signals:backtest
        {symbols=BTCUSDT : satu atau beberapa pair dipisah koma, mis. BTCUSDT,ETHUSDT,SOLUSDT}
        {--days=90 : lama periode uji}
        {--step=4 : evaluasi setiap N jam}
        {--fee=0.10 : biaya round-trip dalam persen (taker 2x)}
        {--min-conf= : override ambang confidence}';

    protected $description = 'Backtest engine sinyal pada data historis Binance Futures';

    public function handle(BinanceFuturesClient $bn): int
    {
        $cfg = config('signal');
        if ($this->option('min-conf') !== null) {
            $cfg['min_confidence'] = (int) $this->option('min-conf');
        }
        $engine = new SignalEngine($cfg);
        $days = (int) $this->option('days');
        $step = max(1, (int) $this->option('step'));
        $fee = (float) $this->option('fee');
        $all = [];

        foreach (array_filter(array_map('trim', explode(',', strtoupper($this->argument('symbols'))))) as $symbol) {
            $this->info("== $symbol: mengambil data historis ...");
            try {
                $now = (int) (microtime(true) * 1000);
                $c15 = $this->fetch($bn, $symbol, '15m', $now - ($days + 5) * 86_400_000);
                $c1h = $this->fetch($bn, $symbol, '1h', $now - ($days + 14) * 86_400_000);
                $c4h = $this->fetch($bn, $symbol, '4h', $now - ($days + 55) * 86_400_000);
            } catch (\Throwable $e) {
                $this->error($e->getMessage());
                continue;
            }
            $trades = $this->walk($engine, $symbol, $c15, $c1h, $c4h, $days, $step, $fee);
            $this->line("   evaluasi selesai, " . count($trades) . ' trade.');
            array_push($all, ...$trades);
        }

        if (!$all) {
            $this->warn('Tidak ada trade yang dihasilkan pada periode ini.');
            return self::SUCCESS;
        }
        $this->report($all, $fee);
        return self::SUCCESS;
    }

    private function fetch(BinanceFuturesClient $bn, string $symbol, string $tf, int $startMs): array
    {
        $out = [];
        $ms = $bn->tfMs($tf);
        $cursor = $startMs;
        while (true) {
            $chunk = $bn->klinesSince($symbol, $tf, $cursor, 1500);
            if (!$chunk) {
                break;
            }
            array_push($out, ...$chunk);
            $cursor = end($chunk)['t'] + $ms;
            if (count($chunk) < 1400) {
                break;
            }
            usleep(150_000);
        }
        return $out;
    }

    private function walk(SignalEngine $engine, string $symbol, array $c15, array $c1h, array $c4h, int $days, int $step, float $fee): array
    {
        $now = (int) (microtime(true) * 1000);
        $from = $now - $days * 86_400_000;
        $trades = [];
        $busyUntil = 0;
        $p15 = $p1h = $p4h = 0;

        for ($T = $from; $T < $now - 3_600_000; $T += $step * 3_600_000) {
            while ($p15 < count($c15) && $c15[$p15]['t'] + 900_000 <= $T) $p15++;
            while ($p1h < count($c1h) && $c1h[$p1h]['t'] + 3_600_000 <= $T) $p1h++;
            while ($p4h < count($c4h) && $c4h[$p4h]['t'] + 14_400_000 <= $T) $p4h++;
            if ($T < $busyUntil || $p15 < 60 || $p1h < 120 || $p4h < 60) {
                continue;
            }
            $price = $c15[$p15 - 1]['c'];
            $a = $engine->analyze(
                $symbol,
                array_slice($c15, max(0, $p15 - 300), min(300, $p15)),
                array_slice($c1h, max(0, $p1h - 300), min(300, $p1h)),
                array_slice($c4h, max(0, $p4h - 300), min(300, $p4h)),
                $price
            );
            if (!in_array($a['side'], ['LONG', 'SHORT'], true)) {
                continue;
            }
            $l = $a['levels'];
            $future = array_slice($c15, $p15, 192);
            $res = TradeSimulator::run($a['side'], $l['entry'], $l['sl'], $l['tp1'], $l['tp2'], $future, 192);
            if (!$res) {
                continue; // belum selesai di data yang tersedia
            }
            $riskPct = max(0.0001, $l['risk_pct']);
            $r = $res['r'] - $fee / $riskPct;
            $trades[] = ['symbol' => $symbol, 'side' => $a['side'], 'conf' => $a['confidence'], 'status' => $res['status'], 'r' => $r, 't' => $T];
            $busyUntil = $T + $res['bars'] * 900_000;
        }
        return $trades;
    }

    private function report(array $t, float $fee): void
    {
        usort($t, fn ($a, $b) => $a['t'] <=> $b['t']);
        $this->newLine();
        $this->info("HASIL BACKTEST (biaya round-trip {$fee}% sudah dikurangkan, satuan R)");
        $row = fn (string $label, array $x) => [$label, ...$this->summ($x)];
        $head = ['Kelompok', 'Trade', 'Win%', 'Avg R', 'Profit factor', 'Total R'];

        $rows = [$row('SEMUA', $t)];
        $rows[] = $row('LONG', array_filter($t, fn ($x) => $x['side'] === 'LONG'));
        $rows[] = $row('SHORT', array_filter($t, fn ($x) => $x['side'] === 'SHORT'));
        foreach ([[0, 70, 'conf < 70'], [70, 80, 'conf 70-79'], [80, 101, 'conf 80+']] as [$lo, $hi, $lab]) {
            $rows[] = $row($lab, array_filter($t, fn ($x) => $x['conf'] >= $lo && $x['conf'] < $hi));
        }
        $this->table($head, $rows);

        $eq = 0.0;
        $peak = 0.0;
        $dd = 0.0;
        $streak = 0;
        $maxStreak = 0;
        foreach ($t as $x) {
            $eq += $x['r'];
            $peak = max($peak, $eq);
            $dd = max($dd, $peak - $eq);
            $streak = $x['r'] < 0 ? $streak + 1 : 0;
            $maxStreak = max($maxStreak, $streak);
        }
        $this->line(sprintf('Max drawdown: %.1fR | Rentetan loss terpanjang: %d trade', $dd, $maxStreak));
        $this->warn('Ingat: hasil lampau bukan jaminan. Faktor futures & BTC tidak ikut diuji. Cek juga tab Riwayat untuk forward-test nyata.');
    }

    private function summ(array $x): array
    {
        $x = array_values($x);
        $n = count($x);
        if (!$n) {
            return [0, '-', '-', '-', '-'];
        }
        $win = count(array_filter($x, fn ($y) => $y['r'] > 0));
        $gain = array_sum(array_map(fn ($y) => max(0, $y['r']), $x));
        $loss = abs(array_sum(array_map(fn ($y) => min(0, $y['r']), $x)));
        $tot = array_sum(array_column($x, 'r'));
        return [$n, round($win / $n * 100, 1), round($tot / $n, 2), $loss > 0 ? round($gain / $loss, 2) : '∞', round($tot, 1)];
    }
}
