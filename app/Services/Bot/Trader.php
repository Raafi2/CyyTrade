<?php

namespace App\Services\Bot;

use App\Services\Binance\BinanceApiException;
use App\Services\Binance\BinanceFuturesClient;

/**
 * Lapisan tipis ke endpoint order Binance USDⓈ-M Futures (bertanda tangan).
 * Endpoint dan parameter diverifikasi dengan dokumentasi resmi Binance (SL/TP kini lewat /fapi/v1/algoOrder).
 */
class Trader
{
    public function __construct(private BinanceFuturesClient $bn) {}

    /** @return array{wallet:float,available:float} */
    public function balance(): array
    {
        $a = $this->versioned('/fapi/v3/account', '/fapi/v2/account');

        return ['wallet' => (float) ($a['totalWalletBalance'] ?? 0), 'available' => (float) ($a['availableBalance'] ?? 0)];
    }

    public function isHedgeMode(): bool
    {
        return (bool) ($this->bn->signed('/fapi/v1/positionSide/dual')['dualSidePosition'] ?? false);
    }

    /** @return list<array<string,mixed>> posisi non-nol */
    public function positions(?string $symbol = null): array
    {
        $q = $symbol ? ['symbol' => $symbol] : [];
        $rows = $this->versioned('/fapi/v3/positionRisk', '/fapi/v2/positionRisk', $q);

        return array_values(array_filter($rows, fn ($p) => (float) ($p['positionAmt'] ?? 0) != 0.0));
    }

    public function setIsolated(string $symbol): void
    {
        try {
            $this->bn->signed('/fapi/v1/marginType', ['symbol' => $symbol, 'marginType' => 'ISOLATED'], 'POST');
        } catch (BinanceApiException $e) {
            if ($e->binanceCode !== -4046) { // -4046: sudah ISOLATED
                throw $e;
            }
        }
    }

    public function setLeverage(string $symbol, int $leverage): int
    {
        $r = $this->bn->signed('/fapi/v1/leverage', ['symbol' => $symbol, 'leverage' => $leverage], 'POST');

        return (int) ($r['leverage'] ?? $leverage);
    }

    /** Order market. $side = BUY|SELL. @return array<string,mixed> */
    public function market(string $symbol, string $side, float $qty, bool $reduceOnly, string $clientId): array
    {
        $q = [
            'symbol' => $symbol, 'side' => $side, 'type' => 'MARKET', 'quantity' => $this->num($qty),
            'newClientOrderId' => $clientId, 'newOrderRespType' => 'RESULT',
        ];
        if ($reduceOnly) {
            $q['reduceOnly'] = 'true';
        }

        return $this->bn->signed('/fapi/v1/order', $q, 'POST');
    }

    /** SL/TP kondisional yang menutup seluruh posisi. $type = STOP_MARKET|TAKE_PROFIT_MARKET. @return string algoId */
    public function conditional(string $symbol, string $closeSide, string $type, float $trigger, string $clientId): string
    {
        $r = $this->bn->signed('/fapi/v1/algoOrder', [
            'algoType' => 'CONDITIONAL', 'symbol' => $symbol, 'side' => $closeSide, 'type' => $type,
            'triggerPrice' => $this->num($trigger), 'closePosition' => 'true', 'workingType' => 'MARK_PRICE',
            'clientAlgoId' => $clientId,
        ], 'POST');

        return (string) ($r['algoId'] ?? '');
    }

    /** @return list<array<string,mixed>> */
    public function openAlgo(string $symbol): array
    {
        $r = $this->bn->signed('/fapi/v1/openAlgoOrders', ['symbol' => $symbol]);

        return array_values($r['orders'] ?? (array_is_list($r) ? $r : []));
    }

    public function cancelAlgo(string $algoId): void
    {
        try {
            $this->bn->signed('/fapi/v1/algoOrder', ['algoId' => $algoId], 'DELETE');
        } catch (BinanceApiException $e) {
            if ($e->httpStatus >= 500 || $e->unknown) {
                throw $e;
            } // selain itu: sudah terpicu/terbatalkan, abaikan
        }
    }

    public function cancelAllAlgo(string $symbol): void
    {
        try {
            $this->bn->signed('/fapi/v1/algoOpenOrders', ['symbol' => $symbol], 'DELETE');
        } catch (BinanceApiException $e) {
            if ($e->unknown) {
                throw $e;
            }
        }
    }

    /** @return list<array<string,mixed>> */
    public function userTrades(string $symbol, int $startMs): array
    {
        return $this->bn->signed('/fapi/v1/userTrades', ['symbol' => $symbol, 'startTime' => $startMs, 'limit' => 500]);
    }

    private function num(float $v): string
    {
        return rtrim(rtrim(sprintf('%.10F', $v), '0'), '.');
    }

    /** @return array<mixed> */
    private function versioned(string $path, string $fallback, array $q = []): array
    {
        try {
            return $this->bn->signed($path, $q);
        } catch (BinanceApiException $e) {
            if ($e->httpStatus !== 404) {
                throw $e;
            }

            return $this->bn->signed($fallback, $q);
        }
    }
}
