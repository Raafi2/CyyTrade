<?php

namespace App\Http\Controllers;

use App\Models\Signal;
use App\Services\Analysis\Indicators as I;
use App\Services\Analysis\SignalEngine;
use App\Services\Binance\BinanceFuturesClient;
use App\Services\SignalTracker;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class AnalysisController extends Controller
{
    public function __construct(private BinanceFuturesClient $bn, private SignalTracker $tracker) {}

    public function symbols(): JsonResponse
    {
        return $this->guard(fn () => $this->bn->symbols((int) config('signal.watchlist_size')));
    }

    public function analysis(string $symbol): JsonResponse
    {
        $symbol = strtoupper($symbol);
        abort_unless(preg_match('/^[A-Z0-9]{2,20}USDT$/', $symbol), 404);

        return $this->guard(function () use ($symbol) {
            $b = $this->bn->bundle($symbol);
            $btc = $symbol === 'BTCUSDT' ? null : $this->bn->btc1h();
            $engine = new SignalEngine(config('signal'));
            $res = $engine->analyze($symbol, $b['c15'], $b['c1h'], $b['c4h'], $b['price'], $b['futures'], $btc);
            $this->tracker->record($res);

            return $res;
        });
    }

    public function candles(Request $r, string $symbol): JsonResponse
    {
        $symbol = strtoupper($symbol);
        abort_unless(preg_match('/^[A-Z0-9]{2,20}USDT$/', $symbol), 404);
        $allowed = ['1m', '3m', '5m', '15m', '1h', '4h'];
        $tf = in_array($r->query('tf'), $allowed, true) ? $r->query('tf') : '1h';

        return $this->guard(function () use ($symbol, $tf) {
            $c = $this->bn->candles($symbol, $tf, 300);
            $cl = array_column($c, 'c');
            $e20 = I::ema($cl, 20);
            $e50 = I::ema($cl, 50);
            $pts = fn (array $s) => array_values(array_filter(
                array_map(fn ($v, $i) => $v === null ? null : ['time' => intdiv($c[$i]['t'], 1000), 'value' => $v], $s, array_keys($s))
            ));

            return [
                'candles' => array_map(fn ($x) => [
                    'time' => intdiv($x['t'], 1000), 'open' => $x['o'], 'high' => $x['h'], 'low' => $x['l'], 'close' => $x['c'],
                ], $c),
                'ema20' => $pts($e20),
                'ema50' => $pts($e50),
            ];
        });
    }

    public function history(): JsonResponse
    {
        return $this->guard(function () {
            $this->tracker->resolveOpen();

            return [
                'stats' => $this->tracker->stats(),
                'signals' => Signal::orderByDesc('opened_at')->limit(100)->get(),
            ];
        });
    }

    private function guard(callable $fn): JsonResponse
    {
        try {
            return response()->json($fn());
        } catch (\Throwable $e) {
            report($e);

            return response()->json(['error' => $e->getMessage()], 502);
        }
    }
}
