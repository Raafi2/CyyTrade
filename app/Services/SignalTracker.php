<?php

namespace App\Services;

use App\Models\Signal;
use App\Services\Analysis\TradeSimulator;
use App\Services\Binance\BinanceFuturesClient;

/**
 * Mencatat sinyal aktif ke riwayat dan menyelesaikan (SL/TP) sinyal terbuka
 * setiap kali website dibuka. Tidak butuh scheduler.
 */
class SignalTracker
{
    public function __construct(private BinanceFuturesClient $bn) {}

    public function record(array $a): ?Signal
    {
        if (!in_array($a['side'], ['LONG', 'SHORT'], true) || !$a['levels']) {
            return null;
        }
        $since = now()->subHours((int) config('signal.record_dedupe_hours'));
        $exists = Signal::where('symbol', $a['symbol'])->where('side', $a['side'])
            ->where('opened_at', '>=', $since)->exists();
        if ($exists) {
            return null;
        }
        $l = $a['levels'];
        return Signal::create([
            'symbol' => $a['symbol'], 'side' => $a['side'], 'confidence' => $a['confidence'], 'bias' => $a['bias'],
            'regime' => $a['regime']['trend'] ?? null,
            'entry' => $l['entry'], 'sl' => $l['sl'], 'tp1' => $l['tp1'], 'tp2' => $l['tp2'],
            'rr1' => $l['rr1'], 'rr2' => $l['rr2'],
            'factors' => $a['factors'], 'reasons' => $a['reasons'],
            'opened_at' => now(),
        ]);
    }

    /** Selesaikan semua sinyal terbuka berdasarkan candle 15m sejak dibuka. */
    public function resolveOpen(): void
    {
        $maxBars = (int) config('signal.track_max_hours') * 4;
        foreach (Signal::where('status', 'open')->orderBy('opened_at')->limit(60)->get() as $s) {
            try {
                $candles = $this->bn->klinesSince($s->symbol, '15m', $s->opened_at->getTimestampMs(), 500);
            } catch (\Throwable) {
                continue;
            }
            $res = TradeSimulator::run($s->side, $s->entry, $s->sl, $s->tp1, $s->tp2, $candles, $maxBars);
            if ($res) {
                $s->update([
                    'status' => $res['status'],
                    'r_result' => $res['r'],
                    'closed_at' => $s->opened_at->copy()->addMinutes(15 * $res['bars']),
                ]);
            }
        }
    }

    public function stats(): array
    {
        $closed = Signal::where('status', '!=', 'open')->get();
        $n = $closed->count();
        $bucket = fn ($lo, $hi) => $closed->filter(fn ($s) => $s->confidence >= $lo && $s->confidence < $hi);
        $summ = function ($c) {
            $n = $c->count();
            if (!$n) {
                return ['n' => 0, 'win_rate' => null, 'avg_r' => null, 'profit_factor' => null];
            }
            $gain = $c->where('r_result', '>', 0)->sum('r_result');
            $loss = abs($c->where('r_result', '<', 0)->sum('r_result'));
            return [
                'n' => $n,
                'win_rate' => round($c->where('r_result', '>', 0)->count() / $n * 100, 1),
                'avg_r' => round($c->avg('r_result'), 2),
                'profit_factor' => $loss > 0 ? round($gain / $loss, 2) : null,
            ];
        };
        return [
            'overall' => $summ($closed),
            'open' => Signal::where('status', 'open')->count(),
            'buckets' => [
                '60-69' => $summ($bucket(0, 70)),
                '70-79' => $summ($bucket(70, 80)),
                '80+' => $summ($bucket(80, 101)),
            ],
        ];
    }
}
