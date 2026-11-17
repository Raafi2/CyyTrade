<?php

namespace App\Console\Commands;

use App\Models\BotEvent;
use App\Models\BotState;
use App\Services\Bot\BotEngine;
use Illuminate\Console\Command;

class BotRun extends Command
{
    protected $signature = 'bot:run';
    protected $description = 'Menjalankan bot scalping (biarkan terminal ini terbuka; Ctrl+C untuk berhenti)';

    public function handle(BotEngine $engine): int
    {
        $st = BotState::current();
        if (now()->getTimestampMs() - $st->heartbeat < 8_000) {
            $this->error('Bot sudah berjalan di terminal lain (detak jantung masih baru). Tutup yang lain dulu.');

            return self::FAILURE;
        }

        $live = (bool) config('bot.live');
        $this->info($live ? 'MODE LIVE: bot akan mengirim order sungguhan bila Anda menekan Mulai di web.' : 'MODE LATIHAN: BOT_LIVE=false, tidak ada order yang dikirim.');
        BotEvent::log('info', 'Proses bot dijalankan ('.($live ? 'LIVE' : 'latihan').'). Bot hanya aktif selama terminal ini terbuka.');

        $stop = false;
        if (function_exists('pcntl_async_signals')) {
            pcntl_async_signals(true);
            pcntl_signal(SIGINT, function () use (&$stop) { $stop = true; });
            pcntl_signal(SIGTERM, function () use (&$stop) { $stop = true; });
        }

        $fails = 0;
        $lastMsg = '';
        $lastErrAt = 0;
        while (! $stop) {
            try {
                $engine->tick();
                $fails = 0;
                $msg = (string) (BotState::find(1)->runtime['status'] ?? '');
                if ($msg !== $lastMsg) {
                    $this->line('['.now()->format('H:i:s').'] '.$msg);
                    $lastMsg = $msg;
                }
            } catch (\Throwable $e) {
                $fails++;
                $text = $e->getMessage();
                $this->warn('['.now()->format('H:i:s').'] '.$text);
                // Satu pesan error yang sama dicatat paling sering sekali per menit.
                if (time() - $lastErrAt > 60) {
                    BotEvent::log('error', 'Siklus gagal: '.$text);
                    $lastErrAt = time();
                }
                if (! ($e instanceof \RuntimeException)) {
                    report($e);
                }
            }
            sleep($fails > 5 ? 15 : 2);
        }

        $this->info('Bot dihentikan. Posisi yang masih terbuka tetap dilindungi SL/TP di Binance.');
        BotEvent::log('warn', 'Proses bot dihentikan. Posisi terbuka (jika ada) hanya dijaga SL/TP di Binance sampai bot dijalankan lagi.');

        return self::SUCCESS;
    }
}
