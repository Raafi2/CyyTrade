<?php

namespace App\Services\Binance;

use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Pool;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use RuntimeException;

/**
 * Klien API publik Binance USDT-M Futures (tanpa API key).
 * Semua data di-cache singkat supaya membuka web berkali-kali tidak membebani rate limit.
 *
 * DNS di-resolve via DoH (Cloudflare) untuk bypass ISP DNS hijacking
 * yang umum terjadi di Indonesia.
 */
class BinanceFuturesClient
{
    private const TF_MS = [
        '1m' => 60_000,
        '3m' => 180_000,
        '5m' => 300_000,
        '15m' => 900_000,
        '1h' => 3_600_000,
        '4h' => 14_400_000,
    ];

    private function base(): string
    {
        return rtrim(config('signal.binance_base'), '/');
    }

    private function ttl(): int
    {
        return (int) config('signal.cache_ttl');
    }

    /**
     * Cari lokasi CA cert bundle yang valid (untuk cURL SSL verification).
     */
    private function caBundlePath(): ?string
    {
        $storageCa = storage_path('cacert.pem');
        if (file_exists($storageCa)) {
            return $storageCa;
        }

        $phpExtraCa = 'C:\\php-8.5.11\\extras\\ssl\\cacert.pem';
        if (file_exists($phpExtraCa)) {
            return $phpExtraCa;
        }

        $curlCa = (string) ini_get('curl.cainfo');
        if ($curlCa !== '' && file_exists($curlCa)) {
            return $curlCa;
        }

        $opensslCa = (string) ini_get('openssl.cafile');
        if ($opensslCa !== '' && file_exists($opensslCa)) {
            return $opensslCa;
        }

        return null;
    }

    /**
     * Opsi SSL untuk Guzzle.
     * Guzzle mendukung 'verify' => '/path/to/cacert.pem' atau 'verify' => false secara langsung.
     */
    private function sslOptions(): array
    {
        if (config('signal.ssl_verify', true) === false) {
            return ['verify' => false];
        }

        $ca = $this->caBundlePath();
        if ($ca !== null) {
            return ['verify' => $ca];
        }

        return [];
    }

    /**
     * Resolve hostname via Cloudflare DNS-over-HTTPS.
     * ISP sering hijack DNS port 53, jadi kita bypass lewat HTTPS.
     *
     * @return string[] IP addresses
     */
    private function resolveViaDoH(string $hostname): array
    {
        return Cache::remember("dns:doh:$hostname", 300, function () use ($hostname) {
            $req = Http::withHeaders(['Accept' => 'application/dns-json'])->timeout(5);
            $sslOpts = $this->sslOptions();
            if ($sslOpts !== []) {
                $req = $req->withOptions($sslOpts);
            }

            try {
                $r = $req->get('https://1.1.1.1/dns-query', ['name' => $hostname, 'type' => 'A']);
                if ($r->successful()) {
                    $ips = [];
                    foreach ($r->json('Answer', []) as $answer) {
                        if (($answer['type'] ?? 0) === 1 && isset($answer['data'])) {
                            $ips[] = $answer['data'];
                        }
                    }

                    if ($ips !== []) {
                        return $ips;
                    }
                }
            } catch (\Throwable) {
                // Abaikan jika DoH gagal, gunakan fallback
            }

            // Fallback CloudFront IPs resmi untuk fapi.binance.com
            return ['108.138.141.52', '108.138.141.24', '108.138.141.5', '108.138.141.35'];
        });
    }

    /**
     * CURLOPT_RESOLVE entries untuk bypass DNS hijacking.
     *
     * @return string[] e.g. ["fapi.binance.com:443:1.2.3.4"]
     */
    private function curlResolve(): array
    {
        $host = parse_url($this->base(), PHP_URL_HOST) ?: 'fapi.binance.com';
        $ips = $this->resolveViaDoH($host);

        if ($ips === []) {
            return [];
        }

        $ip = $ips[array_rand($ips)];

        return ["{$host}:443:{$ip}", "{$host}:80:{$ip}"];
    }

    /**
     * Opsi lengkap HTTP (SSL CA + DNS Resolve).
     */
    private function httpOptions(): array
    {
        $options = $this->sslOptions();
        $resolve = $this->curlResolve();

        if ($resolve !== []) {
            $options['curl'] = [
                CURLOPT_RESOLVE => $resolve,
            ];
        }

        return $options;
    }

    /** PendingRequest dengan SSL CA & DNS-bypass. */
    private function http(): PendingRequest
    {
        $opts = $this->httpOptions();

        return $opts !== [] ? Http::withOptions($opts) : Http::throw();
    }

    /** Daftar pair teratas berdasarkan volume 24 jam. */
    public function symbols(int $limit): array
    {
        $perps = Cache::remember('bn:perps', 6 * 3600, function () {
            $r = $this->http()->timeout(15)->get($this->base().'/fapi/v1/exchangeInfo');
            if (! $r->successful()) {
                throw new RuntimeException('exchangeInfo gagal: HTTP '.$r->status());
            }
            $ok = [];
            foreach ($r->json('symbols', []) as $s) {
                if (($s['contractType'] ?? '') === 'PERPETUAL' && ($s['status'] ?? '') === 'TRADING' && ($s['quoteAsset'] ?? '') === 'USDT') {
                    $ok[$s['symbol']] = true;
                }
            }

            return $ok;
        });

        $tickers = Cache::remember('bn:tickers', 60, function () {
            $r = $this->http()->timeout(15)->get($this->base().'/fapi/v1/ticker/24hr');
            if (! $r->successful()) {
                throw new RuntimeException('ticker24hr gagal: HTTP '.$r->status());
            }

            return $r->json();
        });

        $min = (float) config('signal.min_quote_volume');
        $rows = [];
        foreach ($tickers as $t) {
            if (! isset($perps[$t['symbol']])) {
                continue;
            }
            $qv = (float) $t['quoteVolume'];
            if ($qv < $min) {
                continue;
            }
            $rows[] = [
                'symbol' => $t['symbol'],
                'price' => (float) $t['lastPrice'],
                'change24h' => (float) $t['priceChangePercent'],
                'quote_volume' => $qv,
            ];
        }
        usort($rows, fn ($a, $b) => $b['quote_volume'] <=> $a['quote_volume']);

        return array_slice($rows, 0, $limit);
    }

    /**
     * Paket data lengkap satu pair untuk analisis.
     *
     * @return array{c15:array,c1h:array,c4h:array,price:float,futures:?array}
     */
    public function bundle(string $symbol): array
    {
        return Cache::remember("bn:bundle:$symbol", $this->ttl(), function () use ($symbol) {
            $b = $this->base();
            $p = ['symbol' => $symbol];
            $httpOpts = $this->httpOptions();

            $res = Http::pool(fn (Pool $pool) => [
                $pool->as('k15')->withOptions($httpOpts)->timeout(12)->get("$b/fapi/v1/klines", $p + ['interval' => '15m', 'limit' => 300]),
                $pool->as('k1h')->withOptions($httpOpts)->timeout(12)->get("$b/fapi/v1/klines", $p + ['interval' => '1h', 'limit' => 300]),
                $pool->as('k4h')->withOptions($httpOpts)->timeout(12)->get("$b/fapi/v1/klines", $p + ['interval' => '4h', 'limit' => 300]),
                $pool->as('prem')->withOptions($httpOpts)->timeout(12)->get("$b/fapi/v1/premiumIndex", $p),
                $pool->as('oi')->withOptions($httpOpts)->timeout(12)->get("$b/futures/data/openInterestHist", $p + ['period' => '1h', 'limit' => 30]),
                $pool->as('ls')->withOptions($httpOpts)->timeout(12)->get("$b/futures/data/globalLongShortAccountRatio", $p + ['period' => '1h', 'limit' => 30]),
                $pool->as('tk')->withOptions($httpOpts)->timeout(12)->get("$b/futures/data/takerlongshortRatio", $p + ['period' => '1h', 'limit' => 30]),
            ]);

            foreach (['k15', 'k1h', 'k4h'] as $k) {
                if (! $this->ok($res[$k])) {
                    throw new RuntimeException("Data $symbol ($k) gagal diambil dari Binance.");
                }
            }
            $k15 = $this->parseKlines($res['k15']->json());
            $price = (float) end($k15)['c'];
            $c15 = $this->closedOnly($res['k15']->json(), '15m');
            $c1h = $this->closedOnly($res['k1h']->json(), '1h');
            $c4h = $this->closedOnly($res['k4h']->json(), '4h');

            $fut = [];
            if ($this->ok($res['prem'])) {
                $fut['funding'] = (float) $res['prem']->json('lastFundingRate');
            }
            if ($this->ok($res['oi'])) {
                $fut['oi'] = array_map(fn ($x) => (float) $x['sumOpenInterestValue'], $res['oi']->json());
            }
            if ($this->ok($res['ls'])) {
                $fut['ls'] = array_map(fn ($x) => (float) $x['longShortRatio'], $res['ls']->json());
            }
            if ($this->ok($res['tk'])) {
                $fut['taker'] = array_map(fn ($x) => (float) $x['buySellRatio'], $res['tk']->json());
            }

            return ['c15' => $c15, 'c1h' => $c1h, 'c4h' => $c4h, 'price' => $price, 'futures' => $fut ?: null];
        });
    }

    /** Candle 1h BTC (konteks pasar) untuk analisis altcoin. */
    public function btc1h(): array
    {
        return $this->bundle('BTCUSDT')['c1h'];
    }

    /** Klines (closed) dengan cache, untuk chart. */
    public function candles(string $symbol, string $tf, int $limit = 300): array
    {
        if (in_array($tf, ['15m', '1h', '4h'], true)) {
            $b = $this->bundle($symbol);
            $key = ['15m' => 'c15', '1h' => 'c1h', '4h' => 'c4h'][$tf] ?? 'c1h';

            return array_slice($b[$key], -$limit);
        }

        return Cache::remember("bn:candles:$symbol:$tf", 10, function () use ($symbol, $tf, $limit) {
            $r = $this->http()->timeout(15)->get($this->base().'/fapi/v1/klines', [
                'symbol' => $symbol,
                'interval' => $tf,
                'limit' => $limit,
            ]);

            if (! $r->successful()) {
                throw new RuntimeException("klines $symbol $tf gagal: HTTP ".$r->status());
            }

            return $this->closedOnly($r->json(), $tf);
        });
    }

    /** Klines sejak waktu tertentu (untuk tracker & backtest). Tidak di-cache. */
    public function klinesSince(string $symbol, string $tf, int $startMs, int $limit = 1500): array
    {
        $r = $this->http()->timeout(20)->get($this->base().'/fapi/v1/klines', [
            'symbol' => $symbol, 'interval' => $tf, 'startTime' => $startMs, 'limit' => $limit,
        ]);
        if (! $r->successful()) {
            throw new RuntimeException("klines $symbol $tf gagal: HTTP ".$r->status());
        }

        return $this->closedOnly($r->json(), $tf);
    }

    public function tfMs(string $tf): int
    {
        return self::TF_MS[$tf];
    }

    // ---------------------------------------------------------------------

    private function ok(mixed $r): bool
    {
        return $r instanceof Response && $r->successful();
    }

    private function parseKlines(array $raw): array
    {
        return array_map(fn ($k) => [
            't' => (int) $k[0], 'o' => (float) $k[1], 'h' => (float) $k[2], 'l' => (float) $k[3],
            'c' => (float) $k[4], 'v' => (float) $k[5], 'qv' => (float) $k[7], 'ct' => (int) $k[6],
        ], $raw);
    }

    /** Buang candle yang masih berjalan (belum closed). */
    private function closedOnly(array $raw, string $tf): array
    {
        $now = (int) (microtime(true) * 1000);

        return array_values(array_filter($this->parseKlines($raw), fn ($c) => $c['ct'] < $now));
    }
}
