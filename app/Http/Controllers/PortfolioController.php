<?php

namespace App\Http\Controllers;

use App\Services\Binance\BinanceFuturesClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use RuntimeException;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;

/** Portofolio akun Binance Futures, hanya baca (API key read-only). */
class PortfolioController extends Controller
{
    private const INCOME_TYPES = ['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE'];
    private const MAX_DAYS = 92;

    public function __construct(private BinanceFuturesClient $bn) {}

    public function portfolio(Request $r): JsonResponse
    {
        return $this->guard($r, function () {
            if (! $this->bn->accountConfigured()) {
                return ['configured' => false];
            }

            return Cache::remember('acct:portfolio', 5, function () {
                $acc = $this->versioned('/fapi/v3/account', '/fapi/v2/account');
                $risk = $this->versioned('/fapi/v3/positionRisk', '/fapi/v2/positionRisk');

                $positions = [];
                foreach ($risk as $p) {
                    $amt = (float) ($p['positionAmt'] ?? 0);
                    if ($amt == 0.0) {
                        continue;
                    }
                    $positions[] = [
                        'symbol' => $p['symbol'],
                        'side' => $amt > 0 ? 'LONG' : 'SHORT',
                        'amt' => abs($amt),
                        'entry' => (float) $p['entryPrice'],
                        'mark' => (float) $p['markPrice'],
                        'pnl' => (float) ($p['unRealizedProfit'] ?? $p['unrealizedProfit'] ?? 0),
                        'leverage' => (int) ($p['leverage'] ?? 0),
                        'liq' => (float) ($p['liquidationPrice'] ?? 0),
                        'margin_type' => strtolower((string) ($p['marginType'] ?? '')),
                        'notional' => abs((float) ($p['notional'] ?? 0)),
                    ];
                }

                $assets = [];
                foreach ($acc['assets'] ?? [] as $a) {
                    if ((float) ($a['walletBalance'] ?? 0) != 0.0) {
                        $assets[] = ['asset' => $a['asset'], 'wallet' => (float) $a['walletBalance'], 'pnl' => (float) ($a['unrealizedProfit'] ?? 0)];
                    }
                }

                return [
                    'configured' => true,
                    'wallet' => (float) ($acc['totalWalletBalance'] ?? 0),
                    'unrealized' => (float) ($acc['totalUnrealizedProfit'] ?? 0),
                    'margin_balance' => (float) ($acc['totalMarginBalance'] ?? 0),
                    'available' => (float) ($acc['availableBalance'] ?? 0),
                    'maint_margin' => (float) ($acc['totalMaintMargin'] ?? 0),
                    'assets' => $assets,
                    'positions' => $positions,
                    'fetched_at' => (int) (microtime(true) * 1000),
                ];
            });
        });
    }

    /** Income (PnL terealisasi, fee, funding) pada rentang waktu. from/to dalam ms epoch. */
    public function income(Request $r): JsonResponse
    {
        return $this->guard($r, function () use ($r) {
            if (! $this->bn->accountConfigured()) {
                return ['configured' => false];
            }
            $now = $this->bn->nowMs();
            $from = (int) $r->query('from');
            $to = min((int) $r->query('to'), $now);
            abort_unless($from > 0 && $to > $from, 422, 'Rentang tanggal tidak valid.');
            abort_if($to - $from > self::MAX_DAYS * 86_400_000, 422, 'Rentang maksimal '.self::MAX_DAYS.' hari.');

            $records = Cache::remember("acct:income:$from:$to", 30, fn () => $this->fetchIncome($from, $to));

            $tot = ['REALIZED_PNL' => 0.0, 'COMMISSION' => 0.0, 'FUNDING_FEE' => 0.0];
            foreach ($records as $x) {
                $tot[$x['type']] += $x['income'];
            }

            return [
                'configured' => true,
                'from' => $from, 'to' => $to,
                'totals' => [
                    'realized' => round($tot['REALIZED_PNL'], 4),
                    'commission' => round($tot['COMMISSION'], 4),
                    'funding' => round($tot['FUNDING_FEE'], 4),
                    'net' => round(array_sum($tot), 4),
                ],
                'records' => $records,
                'truncated' => count($records) >= 8000,
            ];
        });
    }

    /** @return list<array{time:int,symbol:string,type:string,income:float}> */
    private function fetchIncome(int $from, int $to): array
    {
        $out = [];
        $cursor = $from;
        for ($page = 0; $page < 8; $page++) {
            $rows = $this->bn->signed('/fapi/v1/income', ['startTime' => $cursor, 'endTime' => $to, 'limit' => 1000]);
            foreach ($rows as $x) {
                // Hanya aset stablecoin quote; transfer dan jenis lain bukan profit trading.
                if (! in_array($x['incomeType'] ?? '', self::INCOME_TYPES, true) || ! in_array($x['asset'] ?? '', ['USDT', 'USDC', 'BUSD', 'FDUSD'], true)) {
                    continue;
                }
                $out[] = ['time' => (int) $x['time'], 'symbol' => (string) ($x['symbol'] ?? ''), 'type' => $x['incomeType'], 'income' => (float) $x['income']];
            }
            if (count($rows) < 1000) {
                break;
            }
            $cursor = (int) end($rows)['time'] + 1;
            usleep(150_000);
        }

        return $out;
    }

    private function versioned(string $path, string $fallback): array
    {
        try {
            return $this->bn->signed($path);
        } catch (RuntimeException $e) {
            if (! str_contains($e->getMessage(), 'tidak tersedia')) {
                throw $e;
            }

            return $this->bn->signed($fallback);
        }
    }

    private function guard(Request $r, callable $fn): JsonResponse
    {
        // Tidak ada login di aplikasi ini: jangan bocorkan data akun ke jaringan.
        $local = in_array($r->ip(), ['127.0.0.1', '::1'], true);
        if (! $local && ! config('signal.account.allow_remote')) {
            return response()->json(['error' => 'Data akun hanya bisa dibuka dari komputer yang sama (localhost).'], 403);
        }

        try {
            return response()->json($fn());
        } catch (HttpExceptionInterface $e) {
            return response()->json(['error' => $e->getMessage() ?: 'Permintaan tidak valid.'], $e->getStatusCode());
        } catch (RuntimeException $e) {
            report($e);

            return response()->json(['error' => $e->getMessage()], 502);
        } catch (\Throwable $e) {
            report($e);

            return response()->json(['error' => 'Terjadi kesalahan di server.'], 500);
        }
    }
}
