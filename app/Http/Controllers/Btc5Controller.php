<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;

/**
 * Perantara data halaman prediksi Binance yang dibaca userscript di browser Anda (tanpa API key, tanpa login lewat server).
 * Userscript mengirim angka yang tampil di layar (harga acuan, persen Naik/Turun, hitung mundur); UI membacanya.
 * Hanya localhost, dan POST wajib memakai header X-Requested-With: fetch.
 */
class Btc5Controller extends Controller
{
    private const KEY = 'btc5:feed';

    public function feed(Request $r): JsonResponse
    {
        return $this->guard($r, function () {
            $f = Cache::get(self::KEY);
            $now = (int) (microtime(true) * 1000);

            return [
                'feed' => $f,
                'age_ms' => $f ? max(0, $now - (int) $f['received_at']) : null,
                'now' => $now,
            ];
        });
    }

    public function push(Request $r): JsonResponse
    {
        return $this->guard($r, function () use ($r) {
            $v = $r->validate([
                'k' => ['nullable', 'numeric', 'min:0.0001', 'max:100000000'],
                'ref' => ['nullable', 'numeric', 'min:0.0001', 'max:100000000'],
                'up' => ['nullable', 'numeric', 'min:0', 'max:100'],
                'down' => ['nullable', 'numeric', 'min:0', 'max:100'],
                'expiry' => ['nullable', 'integer', 'min:0', 'max:4102444800'],
                'left' => ['nullable', 'integer', 'min:0', 'max:86400'],
                'title' => ['nullable', 'string', 'max:160'],
            ]);
            $v['received_at'] = (int) (microtime(true) * 1000);
            Cache::put(self::KEY, $v, 60);

            return ['ok' => true];
        });
    }

    private function guard(Request $r, callable $fn): JsonResponse
    {
        if (! config('signal.account.allow_remote')) {
            $local = in_array($r->ip(), ['127.0.0.1', '::1'], true) && in_array($r->getHost(), ['127.0.0.1', 'localhost', '[::1]', '::1'], true);
            if (! $local) {
                return response()->json(['error' => 'Hanya bisa dibuka dari komputer yang sama (localhost).'], 403);
            }
        }
        if (! $r->isMethod('GET') && $r->header('X-Requested-With') !== 'fetch') {
            return response()->json(['error' => 'Permintaan ditolak.'], 403);
        }

        return response()->json($fn());
    }
}
