<?php

namespace App\Services;

use App\Models\Signal;
use App\Services\Analysis\SignalResolver;
use App\Services\Binance\BinanceFuturesClient;
use Carbon\Carbon;
use Illuminate\Contracts\Cache\LockTimeoutException;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Facades\Cache;

/**
 * Mencatat sinyal aktif ke riwayat dan menyelesaikan (SL/TP) sinyal terbuka memakai candle 1m nyata,
 * lengkap dengan fee, slippage, dan funding riil. Berjalan saat web dibuka; tidak butuh scheduler.
 */
class SignalTracker
{
    public function __construct(private BinanceFuturesClient $bn) {}

    public function record(array $a): ?Signal
    {
        if (! in_array($a['side'], ['LONG', 'SHORT'], true) || ! $a['levels']) {
            return null;
        }

        try {
            return Cache::lock('record:'.$a['symbol'], 10)->block(5, fn () => $this->insertOnce($a));
        } catch (LockTimeoutException) {
            return null;
        }
    }

    private function insertOnce(array $a): ?Signal
    {
        // Tidak membuka sinyal baru selama masih ada posisi terbuka di pair yang sama.
        if (Signal::where('symbol', $a['symbol'])->where('status', 'open')->exists()) {
            return null;
        }
        $since = now()->subHours((int) config('signal.record_dedupe_hours'));
        if (Signal::where('symbol', $a['symbol'])->where('side', $a['side'])->where('opened_at', '>=', $since)->exists()) {
            return null;
        }

        $l = $a['levels'];

        return Signal::create([
            'symbol' => $a['symbol'], 'side' => $a['side'], 'confidence' => $a['confidence'], 'bias' => $a['bias'],
            'regime' => $a['regime']['trend'] ?? null,
            'entry' => $l['entry'], 'sl' => $l['sl'], 'tp1' => $l['tp1'], 'tp2' => $l['tp2'],
            'rr1' => $l['rr1'], 'rr2' => $l['rr2'],
            'factors' => $a['factors'], 'reasons' => $a['reasons'],
            'opened_at' => Carbon::createFromTimestampMs($a['price_at'] ?? (int) (microtime(true) * 1000)),
        ]);
    }

    /**
     * Selesaikan semua sinyal terbuka dari candle 1m nyata sejak dibuka.
     *
     * @return int jumlah sinyal yang selesai pada pemanggilan ini
     */
    public function resolveOpen(): int
    {
        $resolved = 0;
        $maxBars = (int) config('signal.track_max_hours') * 60;

        foreach (Signal::where('status', 'open')->orderBy('opened_at')->get()->groupBy('symbol') as $symbol => $signals) {
            $firstMs = $signals->min(fn (Signal $s) => $s->opened_at->getTimestampMs());
            try {
                $candles = $this->bn->klinesRange($symbol, '1m', $this->nextMinute($firstMs));
            } catch (\Throwable) {
                continue;
            }

            foreach ($signals as $s) {
                $from = $this->nextMinute($s->opened_at->getTimestampMs());
                $mine = array_values(array_filter($candles, fn ($c) => $c['t'] >= $from));
                $res = SignalResolver::run($s->side, $s->entry, $s->sl, $s->tp1, $s->tp2, $mine, $maxBars);
                if (! $res) {
                    continue;
                }

                $costR = $this->costInR($s, $res['closed_ms']);
                $s->update([
                    'status' => $res['status'],
                    'gross_r' => $res['r'],
                    'cost_r' => $costR,
                    'r_result' => round($res['r'] - $costR, 2),
                    'closed_at' => Carbon::createFromTimestampMs($res['closed_ms']),
                ]);
                $resolved++;
            }
        }

        return $resolved;
    }

    private function nextMinute(int $ms): int
    {
        return (int) (ceil($ms / 60_000) * 60_000);
    }

    /** Biaya total dalam R: fee + slippage + funding riil yang terjadi selama posisi terbuka. */
    private function costInR(Signal $s, int $closedMs): float
    {
        $riskPct = abs($s->entry - $s->sl) / $s->entry * 100;
        if ($riskPct <= 0) {
            return 0.0;
        }
        $costPct = (float) config('signal.fee_pct') + (float) config('signal.slippage_pct');

        try {
            $rates = $this->bn->fundingRates($s->symbol, $s->opened_at->getTimestampMs(), $closedMs);
            $sum = array_sum(array_column($rates, 'rate'));
            // Funding positif: long membayar, short menerima. Dihitung pada seluruh posisi (konservatif).
            $costPct += ($s->side === 'LONG' ? $sum : -$sum) * 100;
        } catch (\Throwable) {
            // Funding gagal diambil: hasil memakai fee + slippage saja.
        }

        return round($costPct / $riskPct, 2);
    }

    public function stats(): array
    {
        $closed = fn (): Builder => Signal::where('status', '!=', 'open');

        return [
            'overall' => $this->summarize($closed()),
            'open' => Signal::where('status', 'open')->count(),
            'buckets' => [
                '60-69' => $this->summarize($closed()->where('confidence', '<', 70)),
                '70-79' => $this->summarize($closed()->whereBetween('confidence', [70, 79])),
                '80+' => $this->summarize($closed()->where('confidence', '>=', 80)),
            ],
        ];
    }

    /** Statistik dihitung di database (hasil bersih setelah biaya). */
    private function summarize(Builder $q): array
    {
        $row = $q->selectRaw(
            'count(*) as n,'
            .' sum(case when r_result > 0 then 1 else 0 end) as wins,'
            .' avg(r_result) as avg_r,'
            .' sum(case when r_result > 0 then r_result else 0 end) as gain,'
            .' sum(case when r_result < 0 then -r_result else 0 end) as loss'
        )->first();

        $n = (int) ($row->n ?? 0);
        if ($n === 0) {
            return ['n' => 0, 'win_rate' => null, 'avg_r' => null, 'profit_factor' => null];
        }
        $loss = (float) $row->loss;

        return [
            'n' => $n,
            'win_rate' => round((int) $row->wins / $n * 100, 1),
            'avg_r' => round((float) $row->avg_r, 2),
            'profit_factor' => $loss > 0 ? round((float) $row->gain / $loss, 2) : null,
        ];
    }
}
