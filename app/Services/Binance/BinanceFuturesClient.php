<?php

namespace App\Services\Binance;

use Illuminate\Contracts\Cache\LockTimeoutException;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Pool;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use RuntimeException;

/**
 * Klien API publik Binance USDT-M Futures (tanpa API key).
 *
 * Prinsip data:
 *  - Candle yang sudah closed di-cache sampai candle berikutnya close, jadi selalu sesegar
 *    yang mungkin tanpa memanggil Binance berulang.
 *  - Harga terakhir, mark price, dan funding diambil baru di setiap analisis (cache 3 detik
 *    hanya untuk meredam permintaan serentak).
 *  - Data OI / long-short / taker dari Binance memang per jam, di-cache 5 menit.
 *  - Harga live untuk tampilan datang dari WebSocket di browser, bukan dari sini.
 *
 * DNS di-resolve via DoH untuk melewati pembajakan DNS ISP yang umum di Indonesia.
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

    // ---------------------------------------------------------------------
    // Jaringan: SSL, DNS-over-HTTPS, rate limit
    // ---------------------------------------------------------------------

    private function caBundlePath(): ?string
    {
        $candidates = [
            (string) config('signal.ca_bundle'),
            storage_path('cacert.pem'),
            (string) ini_get('curl.cainfo'),
            (string) ini_get('openssl.cafile'),
        ];
        foreach ($candidates as $path) {
            if ($path !== '' && file_exists($path)) {
                return $path;
            }
        }

        return null;
    }

    private function sslOptions(): array
    {
        if (config('signal.ssl_verify', true) === false) {
            return ['verify' => false];
        }
        $ca = $this->caBundlePath();

        return $ca !== null ? ['verify' => $ca] : [];
    }

    /**
     * Resolve hostname lewat DoH (Cloudflare, lalu Google). Kosong = pakai DNS sistem.
     *
     * @return string[]
     */
    private function resolveViaDoH(string $hostname): array
    {
        $key = "dns:doh:$hostname";
        $cached = Cache::get($key);
        if (is_array($cached)) {
            return $cached;
        }

        $ips = [];
        foreach (['https://1.1.1.1/dns-query', 'https://8.8.8.8/resolve'] as $endpoint) {
            try {
                $r = Http::withOptions($this->sslOptions())
                    ->withHeaders(['Accept' => 'application/dns-json'])
                    ->timeout(5)
                    ->get($endpoint, ['name' => $hostname, 'type' => 'A']);
                if ($r->successful()) {
                    foreach ($r->json('Answer', []) as $answer) {
                        if (($answer['type'] ?? 0) === 1 && isset($answer['data'])) {
                            $ips[] = $answer['data'];
                        }
                    }
                }
            } catch (\Throwable) {
                // coba resolver berikutnya
            }
            if ($ips !== []) {
                break;
            }
        }

        // Kegagalan hanya di-cache sebentar supaya cepat dicoba lagi.
        Cache::put($key, $ips, $ips !== [] ? 300 : 20);

        return $ips;
    }

    private function httpOptions(): array
    {
        $options = $this->sslOptions();
        $host = parse_url($this->base(), PHP_URL_HOST) ?: 'fapi.binance.com';
        $ips = $this->resolveViaDoH($host);
        if ($ips !== []) {
            $ip = $ips[array_rand($ips)];
            $options['curl'] = [CURLOPT_RESOLVE => ["{$host}:443:{$ip}", "{$host}:80:{$ip}"]];
        }

        return $options;
    }

    private function assertNotBackedOff(): void
    {
        $until = (int) Cache::get('bn:backoff_until', 0);
        if ($until > time()) {
            throw new RuntimeException('Binance sedang membatasi request (rate limit). Coba lagi dalam '.($until - time()).' detik.');
        }
    }

    /** HTTP 429/418 dari Binance: hentikan semua request sampai waktu yang diminta. */
    private function noteStatus(mixed $r): void
    {
        if ($r instanceof Response && in_array($r->status(), [429, 418], true)) {
            $wait = (int) ($r->header('Retry-After') ?: ($r->status() === 418 ? 300 : 30));
            $wait = max(5, min($wait, 3600));
            Cache::put('bn:backoff_until', time() + $wait, $wait);
        }
    }

    private function get(string $path, array $query = [], int $timeout = 12): Response
    {
        $this->assertNotBackedOff();
        try {
            $r = Http::withOptions($this->httpOptions())->acceptJson()->timeout($timeout)->get($this->base().$path, $query);
        } catch (ConnectionException $e) {
            throw new RuntimeException('Tidak dapat terhubung ke Binance: '.Str::limit($e->getMessage(), 160));
        }
        $this->noteStatus($r);

        return $r;
    }

    private function ok(mixed $r): bool
    {
        return $r instanceof Response && $r->successful();
    }

    // ---------------------------------------------------------------------
    // Cache dengan lock (mencegah banyak request mengambil data yang sama)
    // ---------------------------------------------------------------------

    private function withLock(string $name, callable $fn): void
    {
        $lock = Cache::lock("lock:$name", 25);
        try {
            $lock->block(10);
        } catch (LockTimeoutException) {
            throw new RuntimeException('Server sibuk mengambil data pasar, coba lagi sebentar.');
        }
        try {
            $fn();
        } finally {
            $lock->release();
        }
    }

    private function remember(string $key, int $ttl, callable $fn): mixed
    {
        $hit = Cache::get($key);
        if ($hit !== null) {
            return $hit;
        }
        $out = null;
        $this->withLock($key, function () use ($key, $ttl, $fn, &$out) {
            $out = Cache::get($key);
            if ($out === null) {
                $out = $fn();
                Cache::put($key, $out, $ttl);
            }
        });

        return $out;
    }

    // ---------------------------------------------------------------------
    // Waktu
    // ---------------------------------------------------------------------

    /** Waktu server Binance (ms), dikoreksi dengan selisih jam lokal. */
    public function nowMs(): int
    {
        $offset = Cache::get('bn:time_offset');
        if ($offset === null) {
            $offset = 0;
            try {
                $t0 = (int) (microtime(true) * 1000);
                $r = $this->get('/fapi/v1/time', [], 5);
                if ($r->successful()) {
                    $t1 = (int) (microtime(true) * 1000);
                    $offset = (int) $r->json('serverTime') - intdiv($t0 + $t1, 2);
                }
            } catch (\Throwable) {
                // pakai jam lokal
            }
            Cache::put('bn:time_offset', $offset, 600);
        }

        return (int) (microtime(true) * 1000) + (int) $offset;
    }

    /** Detik sampai candle timeframe ini berikutnya close (+2 detik toleransi). */
    private function untilNextClose(string $tf): int
    {
        $ms = self::TF_MS[$tf];
        $now = $this->nowMs();
        $next = (intdiv($now, $ms) + 1) * $ms;

        return max(5, (int) ceil(($next - $now) / 1000) + 2);
    }

    public function tfMs(string $tf): int
    {
        return self::TF_MS[$tf];
    }

    // ---------------------------------------------------------------------
    // Daftar pair
    // ---------------------------------------------------------------------

    /** @return array<string,true> semua USDT-M perpetual yang sedang trading */
    public function perps(): array
    {
        return $this->remember('bn:perps', 6 * 3600, function () {
            $r = $this->get('/fapi/v1/exchangeInfo', [], 15);
            if (! $r->successful()) {
                throw new RuntimeException('exchangeInfo gagal: HTTP '.$r->status());
            }
            $ok = [];
            foreach ($r->json('symbols', []) as $s) {
                if (($s['contractType'] ?? '') === 'PERPETUAL' && ($s['status'] ?? '') === 'TRADING' && ($s['quoteAsset'] ?? '') === 'USDT') {
                    $ok[$s['symbol']] = true;
                }
            }
            if ($ok === []) {
                throw new RuntimeException('exchangeInfo kosong.');
            }

            return $ok;
        });
    }

    public function isTradable(string $symbol): bool
    {
        return isset($this->perps()[$symbol]);
    }

    /** Daftar pair teratas berdasarkan volume 24 jam. */
    public function symbols(int $limit): array
    {
        $perps = $this->perps();
        $tickers = $this->remember('bn:tickers', 15, function () {
            $r = $this->get('/fapi/v1/ticker/24hr', [], 15);
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

    // ---------------------------------------------------------------------
    // Data analisis
    // ---------------------------------------------------------------------

    /**
     * Paket data lengkap satu pair untuk analisis. Hanya bagian yang kedaluwarsa yang diambil ulang,
     * semuanya dalam satu pool paralel.
     *
     * @return array{c15:array,c1h:array,c4h:array,price:float,price_at:int,mark:?float,funding:?float,next_funding:?int,futures:?array}
     */
    public function bundle(string $symbol): array
    {
        $plan = [
            'k15' => ["bn:k:$symbol:15m", $this->untilNextClose('15m')],
            'k1h' => ["bn:k:$symbol:1h", $this->untilNextClose('1h')],
            'k4h' => ["bn:k:$symbol:4h", $this->untilNextClose('4h')],
            'live' => ["bn:live:$symbol", max(1, (int) config('signal.live_ttl'))],
            'fut' => ["bn:fut:$symbol", max(30, (int) config('signal.futures_ttl'))],
        ];

        $data = $this->readPlan($plan);
        if (in_array(null, $data, true)) {
            $this->withLock("bn:bundle:$symbol", function () use ($symbol, $plan, &$data) {
                $data = $this->readPlan($plan);
                $missing = array_keys(array_filter($data, fn ($v) => $v === null));
                if ($missing !== []) {
                    $this->fetchMissing($symbol, $missing, $plan, $data);
                }
            });
        }

        $live = $data['live'];
        $fut = $data['fut'];
        if (isset($live['funding'])) {
            $fut['funding'] = $live['funding'];
        }

        return [
            'c15' => $data['k15'],
            'c1h' => $data['k1h'],
            'c4h' => $data['k4h'],
            'price' => $live['price'],
            'price_at' => $live['at'],
            'mark' => $live['mark'] ?? null,
            'funding' => $live['funding'] ?? null,
            'next_funding' => $live['next_funding'] ?? null,
            'futures' => $fut ?: null,
        ];
    }

    /** @return array<string,mixed> */
    private function readPlan(array $plan): array
    {
        return array_map(fn ($p) => Cache::get($p[0]), $plan);
    }

    private function fetchMissing(string $symbol, array $missing, array $plan, array &$data): void
    {
        $p = ['symbol' => $symbol];
        $tfs = ['k15' => '15m', 'k1h' => '1h', 'k4h' => '4h'];
        $reqs = [];
        foreach ($tfs as $k => $tf) {
            if (in_array($k, $missing, true)) {
                $reqs[$k] = ['/fapi/v1/klines', $p + ['interval' => $tf, 'limit' => 300]];
            }
        }
        if (in_array('live', $missing, true)) {
            $reqs['px'] = ['/fapi/v1/ticker/price', $p];
            $reqs['prem'] = ['/fapi/v1/premiumIndex', $p];
        }
        if (in_array('fut', $missing, true)) {
            $reqs['oi'] = ['/futures/data/openInterestHist', $p + ['period' => '1h', 'limit' => 30]];
            $reqs['ls'] = ['/futures/data/globalLongShortAccountRatio', $p + ['period' => '1h', 'limit' => 30]];
            $reqs['tk'] = ['/futures/data/takerlongshortRatio', $p + ['period' => '1h', 'limit' => 30]];
        }

        $this->assertNotBackedOff();
        $base = $this->base();
        $opts = $this->httpOptions();
        $res = Http::pool(function (Pool $pool) use ($reqs, $opts, $base) {
            $out = [];
            foreach ($reqs as $name => [$path, $query]) {
                $out[] = $pool->as($name)->withOptions($opts)->acceptJson()->timeout(12)->get($base.$path, $query);
            }

            return $out;
        });
        foreach ($res as $r) {
            $this->noteStatus($r);
        }

        foreach ($tfs as $k => $tf) {
            if (! in_array($k, $missing, true)) {
                continue;
            }
            if (! $this->ok($res[$k])) {
                throw new RuntimeException("Data $symbol ($tf) gagal diambil dari Binance.");
            }
            $val = $this->closedOnly($res[$k]->json());
            Cache::put($plan[$k][0], $val, $plan[$k][1]);
            $data[$k] = $val;
        }

        if (in_array('live', $missing, true)) {
            if (! $this->ok($res['px'])) {
                throw new RuntimeException("Harga $symbol gagal diambil dari Binance.");
            }
            $live = ['price' => (float) $res['px']->json('price'), 'at' => $this->nowMs()];
            if ($this->ok($res['prem'])) {
                $live['mark'] = (float) $res['prem']->json('markPrice');
                $live['funding'] = (float) $res['prem']->json('lastFundingRate');
                $live['next_funding'] = (int) $res['prem']->json('nextFundingTime');
            }
            Cache::put($plan['live'][0], $live, $plan['live'][1]);
            $data['live'] = $live;
        }

        if (in_array('fut', $missing, true)) {
            $fut = [];
            if ($this->ok($res['oi'])) {
                $fut['oi'] = array_map(fn ($x) => (float) $x['sumOpenInterestValue'], $res['oi']->json());
            }
            if ($this->ok($res['ls'])) {
                $fut['ls'] = array_map(fn ($x) => (float) $x['longShortRatio'], $res['ls']->json());
            }
            if ($this->ok($res['tk'])) {
                $fut['taker'] = array_map(fn ($x) => (float) $x['buySellRatio'], $res['tk']->json());
            }
            // Bila ada bagian yang gagal, coba lagi lebih cepat.
            Cache::put($plan['fut'][0], $fut, count($fut) === 3 ? $plan['fut'][1] : 30);
            $data['fut'] = $fut;
        }
    }

    /** Candle yang sudah closed, di-cache sampai candle berikutnya close. */
    public function closedCandles(string $symbol, string $tf, int $limit = 300): array
    {
        return $this->remember("bn:k:$symbol:$tf", $this->untilNextClose($tf), function () use ($symbol, $tf, $limit) {
            $r = $this->get('/fapi/v1/klines', ['symbol' => $symbol, 'interval' => $tf, 'limit' => $limit]);
            if (! $r->successful()) {
                throw new RuntimeException("klines $symbol $tf gagal: HTTP ".$r->status());
            }

            return $this->closedOnly($r->json());
        });
    }

    /** Candle 1h BTC (konteks pasar) untuk analisis altcoin. */
    public function btc1h(): array
    {
        return $this->closedCandles('BTCUSDT', '1h');
    }

    /** Candle untuk chart, termasuk candle yang sedang berjalan. Cache hanya beberapa detik. */
    public function chartCandles(string $symbol, string $tf, int $limit = 300): array
    {
        return $this->remember("bn:chart:$symbol:$tf", max(1, (int) config('signal.live_ttl')), function () use ($symbol, $tf, $limit) {
            $r = $this->get('/fapi/v1/klines', ['symbol' => $symbol, 'interval' => $tf, 'limit' => $limit]);
            if (! $r->successful()) {
                throw new RuntimeException("klines $symbol $tf gagal: HTTP ".$r->status());
            }

            return $this->parseKlines($r->json());
        });
    }

    // ---------------------------------------------------------------------
    // Data untuk pelacakan hasil sinyal (data pasar nyata, tidak di-cache)
    // ---------------------------------------------------------------------

    /** Candle closed dari $startMs sampai sekarang. */
    public function klinesRange(string $symbol, string $tf, int $startMs, int $maxPages = 4): array
    {
        $out = [];
        $cursor = $startMs;
        $ms = self::TF_MS[$tf];
        for ($i = 0; $i < $maxPages; $i++) {
            $r = $this->get('/fapi/v1/klines', [
                'symbol' => $symbol, 'interval' => $tf, 'startTime' => $cursor, 'limit' => 1500,
            ], 20);
            if (! $r->successful()) {
                throw new RuntimeException("klines $symbol $tf gagal: HTTP ".$r->status());
            }
            $chunk = $this->parseKlines($r->json());
            if ($chunk === []) {
                break;
            }
            array_push($out, ...$chunk);
            $cursor = end($chunk)['t'] + $ms;
            if (count($chunk) < 1500) {
                break;
            }
            usleep(100_000);
        }
        $now = $this->nowMs();

        return array_values(array_filter($out, fn ($c) => $c['ct'] < $now));
    }

    /**
     * Funding rate nyata yang sudah settle pada rentang waktu.
     *
     * @return list<array{time:int,rate:float}>
     */
    public function fundingRates(string $symbol, int $startMs, int $endMs): array
    {
        $r = $this->get('/fapi/v1/fundingRate', [
            'symbol' => $symbol, 'startTime' => $startMs, 'endTime' => $endMs, 'limit' => 100,
        ]);
        if (! $r->successful()) {
            throw new RuntimeException("fundingRate $symbol gagal: HTTP ".$r->status());
        }

        return array_map(fn ($x) => ['time' => (int) $x['fundingTime'], 'rate' => (float) $x['fundingRate']], $r->json());
    }

    // ---------------------------------------------------------------------

    private function parseKlines(array $raw): array
    {
        return array_map(fn ($k) => [
            't' => (int) $k[0], 'o' => (float) $k[1], 'h' => (float) $k[2], 'l' => (float) $k[3],
            'c' => (float) $k[4], 'v' => (float) $k[5], 'qv' => (float) $k[7], 'ct' => (int) $k[6],
        ], $raw);
    }

    /** Buang candle yang masih berjalan (belum closed), memakai waktu server Binance. */
    private function closedOnly(array $raw): array
    {
        $now = $this->nowMs();

        return array_values(array_filter($this->parseKlines($raw), fn ($c) => $c['ct'] < $now));
    }
}
