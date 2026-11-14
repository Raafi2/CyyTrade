<?php

namespace App\Http\Controllers;

use App\Models\Signal;
use App\Services\Analysis\SignalEngine;
use App\Services\Binance\BinanceFuturesClient;
use App\Services\SignalTracker;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use RuntimeException;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;

class AnalysisController extends Controller
{
    private const TIMEFRAMES = ['1m', '3m', '5m', '15m', '1h', '4h'];

    public function __construct(private BinanceFuturesClient $bn, private SignalTracker $tracker) {}

    public function symbols(): JsonResponse
    {
        return $this->guard(fn () => $this->bn->symbols((int) config('signal.watchlist_size')));
    }

    public function analysis(Request $r, string $symbol): JsonResponse
    {
        $symbol = strtoupper($symbol);
        $mode = $r->query('mode') === 'scalp' ? 'scalp' : 'swing';

        return $this->guard(function () use ($symbol, $mode) {
            $this->assertSymbol($symbol);

            $preset = config("signal.modes.$mode");
            $b = $this->bn->bundle($symbol, $mode);
            $btc = $symbol === 'BTCUSDT' ? null : $this->bn->btcCandles($preset['main']);

            $cfg = config('signal');
            $cfg['tf'] = $preset;
            $cfg['cost_pct'] = (float) $cfg['fee_pct'] + (float) $cfg['slippage_pct'];
            if (isset($preset['min_confidence'])) {
                $cfg['min_confidence'] = $preset['min_confidence'];
            }
            if (isset($preset['max_cost_r'])) {
                $cfg['veto']['max_cost_r'] = $preset['max_cost_r'];
            }

            $res = (new SignalEngine($cfg))->analyze($symbol, $b['trig'], $b['main'], $b['htf'], $b['price'], $b['futures'], $btc);

            // Waktu yang ditampilkan adalah waktu harga diambil, bukan waktu komputasi.
            $res['mode'] = $mode;
            $res['price_at'] = $b['price_at'];
            $res['generated_at'] = intdiv($b['price_at'], 1000);
            $res['live'] = ['mark' => $b['mark'], 'funding' => $b['funding'], 'next_funding' => $b['next_funding']];

            // Riwayat dan statistik hanya untuk sinyal swing; scalp dipantau lewat tab Scalping.
            if ($mode === 'swing') {
                $this->tracker->record($res);
            }

            return $res;
        });
    }

    public function candles(Request $r, string $symbol): JsonResponse
    {
        $symbol = strtoupper($symbol);
        $tf = in_array($r->query('tf'), self::TIMEFRAMES, true) ? $r->query('tf') : '1h';

        return $this->guard(function () use ($symbol, $tf) {
            $this->assertSymbol($symbol);
            $c = $this->bn->chartCandles($symbol, $tf, 300);

            return [
                'candles' => array_map(fn ($x) => [
                    'time' => intdiv($x['t'], 1000), 'open' => $x['o'], 'high' => $x['h'], 'low' => $x['l'], 'close' => $x['c'],
                ], $c),
                'server_time' => $this->bn->nowMs(),
            ];
        });
    }

    public function history(): JsonResponse
    {
        return $this->guard(function () {
            $this->tracker->resolveOpen();

            return [
                'stats' => $this->tracker->stats(),
                'signals' => Signal::orderByDesc('opened_at')->limit(100)->get($this->listColumns()),
            ];
        });
    }

    /** Dipanggil berkala saat web terbuka: selesaikan sinyal terbuka dengan data pasar nyata. */
    public function track(): JsonResponse
    {
        return $this->guard(function () {
            $resolved = $this->tracker->resolveOpen();

            return [
                'resolved' => $resolved,
                'open' => Signal::where('status', 'open')->orderBy('opened_at')->get($this->listColumns()),
            ];
        });
    }

    /** Hanya pair USDT-M perpetual yang benar-benar ada di Binance. */
    private function assertSymbol(string $symbol): void
    {
        abort_unless(preg_match('/^[A-Z0-9]{2,20}USDT$/', $symbol) === 1 && $this->bn->isTradable($symbol), 404);
    }

    private function listColumns(): array
    {
        return [
            'id', 'symbol', 'side', 'confidence', 'bias', 'regime', 'entry', 'sl', 'tp1', 'tp2', 'rr1', 'rr2',
            'status', 'r_result', 'gross_r', 'cost_r', 'opened_at', 'closed_at',
        ];
    }

    private function guard(callable $fn): JsonResponse
    {
        try {
            return response()->json($fn());
        } catch (HttpExceptionInterface $e) {
            throw $e;
        } catch (RuntimeException $e) {
            report($e);

            return response()->json(['error' => $e->getMessage()], 502);
        } catch (\Throwable $e) {
            report($e);

            return response()->json(['error' => 'Terjadi kesalahan di server.'], 500);
        }
    }
}
