<?php

namespace App\Http\Controllers;

use App\Models\IncomeRecord;
use App\Services\Binance\BinanceFuturesClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use RuntimeException;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;

/** Portofolio akun Binance Futures, hanya baca (API key read-only). */
class PortfolioController extends Controller
{
    private const INCOME_TYPES = ['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE', 'TRANSFER'];
    // Binance hanya menyimpan sekitar 3 bulan income; sisanya dikumpulkan di database lokal tiap aplikasi dibuka.
    private const API_DAYS = 90;
    private const MAX_ROWS = 30000;

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

    /**
     * Income pada rentang waktu (ms epoch). Data baru disinkronkan dari Binance ke database lokal,
     * lalu dibaca dari sana sehingga riwayat tidak terbatas 3 bulan setelah aplikasi dipakai beberapa kali.
     */
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

            $syncError = null;
            try {
                $this->syncIncome($now);
            } catch (RuntimeException $e) {
                // Tetap tampilkan data yang sudah tersimpan bila Binance gagal dihubungi.
                $syncError = $e->getMessage();
            }

            $rows = IncomeRecord::where('time', '>=', $from)->where('time', '<=', $to)->orderBy('time')
                ->limit(self::MAX_ROWS + 1)->get(['time', 'symbol', 'type', 'income']);
            $truncated = $rows->count() > self::MAX_ROWS;
            $records = $rows->take(self::MAX_ROWS)->map(fn ($x) => [
                'time' => $x->time, 'symbol' => $x->symbol, 'type' => $x->type, 'income' => $x->income,
            ])->values()->all();

            $tot = ['REALIZED_PNL' => 0.0, 'COMMISSION' => 0.0, 'FUNDING_FEE' => 0.0, 'TRANSFER' => 0.0];
            foreach ($records as $x) {
                $tot[$x['type']] += $x['income'];
            }
            $net = $tot['REALIZED_PNL'] + $tot['COMMISSION'] + $tot['FUNDING_FEE'];

            return [
                'configured' => true,
                'from' => $from, 'to' => $to,
                'earliest' => IncomeRecord::min('time'),
                'api_limit_days' => self::API_DAYS,
                'totals' => [
                    'realized' => round($tot['REALIZED_PNL'], 4),
                    'commission' => round($tot['COMMISSION'], 4),
                    'funding' => round($tot['FUNDING_FEE'], 4),
                    'transfer' => round($tot['TRANSFER'], 4),
                    'net' => round($net, 4),
                ],
                'records' => $records,
                'truncated' => $truncated,
                'sync_error' => $syncError,
            ];
        });
    }

    /** Ambil income baru dari Binance (maksimal tiap 30 detik) dan simpan ke database lokal. */
    private function syncIncome(int $now): void
    {
        if (Cache::has('acct:income:synced')) {
            return;
        }
        $last = IncomeRecord::max('time');
        $floor = $now - self::API_DAYS * 86_400_000;
        // Tumpang tindih 2 hari supaya catatan yang terlambat muncul di Binance tetap tertangkap.
        $start = $last === null ? $floor : max($floor, (int) $last - 2 * 86_400_000);

        $cursor = $start;
        for ($page = 0; $page < 30; $page++) {
            $rows = $this->bn->signed('/fapi/v1/income', ['startTime' => $cursor, 'endTime' => $now, 'limit' => 1000]);
            $batch = [];
            foreach ($rows as $x) {
                // Hanya aset stablecoin quote; jenis lain bukan profit trading.
                if (! in_array($x['incomeType'] ?? '', self::INCOME_TYPES, true) || ! in_array($x['asset'] ?? '', ['USDT', 'USDC', 'BUSD', 'FDUSD'], true)) {
                    continue;
                }
                $time = (int) $x['time'];
                $symbol = (string) ($x['symbol'] ?? '');
                $income = (float) $x['income'];
                $batch[] = [
                    'type' => $x['incomeType'],
                    'tran_id' => (string) (($x['tranId'] ?? '') !== '' ? $x['tranId'] : md5("$time|$symbol|$income")),
                    'symbol' => $symbol, 'income' => $income, 'time' => $time,
                ];
            }
            foreach (array_chunk($batch, 200) as $chunk) {
                IncomeRecord::upsert($chunk, ['type', 'tran_id'], ['symbol', 'income', 'time']);
            }
            if (count($rows) < 1000) {
                break;
            }
            $cursor = (int) end($rows)['time'] + 1;
            usleep(150_000);
        }
        Cache::put('acct:income:synced', true, 30);
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
        $local = in_array($r->ip(), ['127.0.0.1', '::1'], true) && in_array($r->getHost(), ['127.0.0.1', 'localhost', '[::1]', '::1'], true);
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
