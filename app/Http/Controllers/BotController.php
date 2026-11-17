<?php

namespace App\Http\Controllers;

use App\Models\BotEvent;
use App\Models\BotState;
use App\Models\BotTrade;
use Carbon\Carbon;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** Kontrol dan status bot untuk UI. Hanya localhost. Tidak pernah mengirim order sendiri; itu tugas proses `bot:run`. */
class BotController extends Controller
{
    public function state(Request $r): JsonResponse
    {
        return $this->guard($r, function () {
            $st = BotState::current();
            $tz = config('bot.tz');
            $dayStart = Carbon::now($tz)->startOfDay()->getTimestampMs();
            $trades = BotTrade::orderByDesc('id')->limit(30)->get();
            $closedToday = BotTrade::where('status', '!=', 'open')->where('closed_at', '>=', $dayStart);
            $total = BotTrade::where('status', '!=', 'open')->whereNotNull('pnl');

            return [
                'enabled' => $st->enabled,
                'live' => (bool) config('bot.live'),
                'configured' => (bool) config('signal.account.key'),
                'heartbeat' => $st->heartbeat,
                'now' => (int) (microtime(true) * 1000),
                'settings' => $st->settings,
                'caps' => config('bot.caps'),
                'runtime' => $st->runtime ?? [],
                'today' => [
                    'trades' => (clone $closedToday)->count(),
                    'wins' => (clone $closedToday)->where('pnl', '>', 0)->count(),
                    'pnl' => round((float) (clone $closedToday)->sum('pnl'), 4),
                ],
                'total' => [
                    'trades' => (clone $total)->count(),
                    'wins' => (clone $total)->where('pnl', '>', 0)->count(),
                    'pnl' => round((float) (clone $total)->sum('pnl'), 4),
                ],
                'trades' => $trades->map(fn ($t) => [
                    'id' => $t->id, 'symbol' => $t->symbol, 'side' => $t->side, 'leverage' => $t->leverage, 'entry' => $t->entry,
                    'exit' => $t->exit_price, 'sl' => $t->sl, 'tp' => $t->tp, 'status' => $t->status, 'pnl' => $t->pnl,
                    'opened_at' => $t->opened_at, 'closed_at' => $t->closed_at,
                ]),
                'events' => BotEvent::orderByDesc('id')->limit(40)->get(['time', 'level', 'message']),
            ];
        });
    }

    public function settings(Request $r): JsonResponse
    {
        return $this->guard($r, function () use ($r) {
            $caps = config('bot.caps');
            $v = $r->validate([
                'risk_pct' => ['required', 'numeric', 'min:0.2', 'max:'.$caps['risk_pct']],
                'max_leverage' => ['required', 'integer', 'min:1', 'max:'.$caps['max_leverage']],
                'target_usd' => ['required', 'numeric', 'min:0', 'max:1000'],
                'daily_loss_pct' => ['required', 'numeric', 'min:1', 'max:'.$caps['daily_loss_pct']],
                'max_hold_min' => ['required', 'integer', 'min:3', 'max:'.$caps['max_hold_min']],
            ]);
            $st = BotState::current();
            $st->settings = array_merge($st->settings, $v);
            $st->save();
            BotEvent::log('info', 'Pengaturan diubah: risiko '.$v['risk_pct'].'%, leverage maks '.$v['max_leverage'].'x, target '.$v['target_usd'].' USDT, batas rugi harian '.$v['daily_loss_pct'].'%.');

            return ['ok' => true];
        });
    }

    public function start(Request $r): JsonResponse
    {
        return $this->guard($r, function () {
            BotState::current();
            BotState::where('id', 1)->update(['enabled' => true]);
            BotEvent::log('info', 'Bot DIMULAI dari web.');

            return ['ok' => true];
        });
    }

    /** Berhenti mencari trade baru. Posisi yang sedang terbuka tetap dipantau sampai selesai. */
    public function stop(Request $r): JsonResponse
    {
        return $this->guard($r, function () {
            BotState::current();
            BotState::where('id', 1)->update(['enabled' => false]);
            BotEvent::log('info', 'Bot DIHENTIKAN dari web (posisi terbuka tetap dipantau sampai selesai).');

            return ['ok' => true];
        });
    }

    /** Tutup posisi bot sekarang dan hentikan bot. Dieksekusi oleh proses bot:run pada siklus berikutnya. */
    public function panic(Request $r): JsonResponse
    {
        return $this->guard($r, function () {
            BotState::current();
            BotState::where('id', 1)->update(['panic' => true]);

            return ['ok' => true];
        });
    }

    private function guard(Request $r, callable $fn): JsonResponse
    {
        if (! config('signal.account.allow_remote')) {
            $local = in_array($r->ip(), ['127.0.0.1', '::1'], true) && in_array($r->getHost(), ['127.0.0.1', 'localhost', '[::1]', '::1'], true);
            if (! $local) {
                return response()->json(['error' => 'Kontrol bot hanya bisa dibuka dari komputer yang sama (localhost).'], 403);
            }
        }
        // Perubahan wajib berasal dari halaman ini (header kustom memicu preflight CORS, sehingga situs lain tidak bisa memicunya).
        if (! $r->isMethod('GET') && $r->header('X-Requested-With') !== 'fetch') {
            return response()->json(['error' => 'Permintaan ditolak.'], 403);
        }

        return response()->json($fn());
    }
}
