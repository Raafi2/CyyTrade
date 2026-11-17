<?php

namespace App\Services\Bot;

use App\Models\BotEvent;
use App\Models\BotState;
use App\Models\BotTrade;
use App\Services\Analysis\AnalysisRunner;
use App\Services\Binance\BinanceApiException;
use App\Services\Binance\BinanceFuturesClient;
use Carbon\Carbon;
use RuntimeException;

/**
 * Mesin bot scalping. Satu posisi dalam satu waktu. Dipanggil berulang oleh `php artisan bot:run`.
 *
 * Aturan keselamatan:
 *  - Order hanya dikirim bila BOT_LIVE=true di .env.
 *  - Setiap posisi langsung diberi SL (dan TP) di Binance; jika SL gagal dipasang, posisi ditutup saat itu juga.
 *  - Saat posisi terbuka bot memantau terus: SL/TP masih ada, sinyal berbalik, geser SL ke impas, batas waktu.
 *  - Batas rugi harian, jeda setelah rugi beruntun, dan tombol darurat.
 */
class BotEngine
{
    private const SCAN_MS = 20_000;
    private const SIGNAL_MS = 15_000;
    private const GUARD_MS = 10_000;
    private const BALANCE_MS = 10_000;

    public function __construct(private BinanceFuturesClient $bn, private Trader $trader, private AnalysisRunner $analysis) {}

    public function tick(): void
    {
        $now = $this->bn->nowMs();
        $st = BotState::current();
        $s = $st->settings;
        $rt = $st->runtime ?? [];
        $rt['live'] = (bool) config('bot.live');
        $rt['testnet'] = str_contains((string) config('signal.binance_base'), 'testnet');

        if (! $this->bn->accountConfigured()) {
            $rt['status'] = 'API key belum diatur di .env';
            $this->save($st, $rt, $now);

            return;
        }

        try {
            $this->refreshBalance($rt, $now);
            $this->rollDay($rt, $now);
            $open = BotTrade::where('status', 'open')->orderBy('id')->first();

            if ($st->panic) {
                $this->panic($open, $rt, $now);
                BotState::where('id', 1)->update(['panic' => false, 'enabled' => false]);
            } elseif ($open) {
                $this->manage($open, $s, $rt, $now);
            } elseif ($st->enabled) {
                $rt['position'] = null;
                $this->tryEnter($s, $rt, $now);
            } else {
                $rt['position'] = null;
                $rt['status'] = 'Berhenti. Tekan Mulai untuk menjalankan bot.';
            }
        } finally {
            $this->save($st, $rt, $now);
        }
    }

    // ---------------------------------------------------------------- masuk posisi

    private function tryEnter(array $s, array &$rt, int $now): void
    {
        $limit = ($rt['day']['start'] ?? 0) * $s['daily_loss_pct'] / 100;
        $dayPnl = $this->dayPnl($rt);
        $rt['day_pnl'] = round($dayPnl, 4);
        $rt['day_limit'] = round($limit, 4);
        if ($limit > 0 && $dayPnl <= -$limit) {
            $this->stopBot();
            $rt['status'] = 'Berhenti: batas rugi harian tercapai.';
            BotEvent::log('warn', sprintf('Batas rugi harian tercapai (%.2f USDT). Bot dihentikan sampai Anda menekan Mulai lagi.', $dayPnl));

            return;
        }
        if (($rt['pause_until'] ?? 0) > $now) {
            $rt['status'] = 'Jeda setelah rugi beruntun sampai '.Carbon::createFromTimestampMs($rt['pause_until'], config('bot.tz'))->format('H:i');

            return;
        }
        if ($now - ($rt['last_scan'] ?? 0) < self::SCAN_MS) {
            return;
        }
        $rt['last_scan'] = $now;
        $rt['status'] = 'Mencari peluang scalping…';

        $live = (bool) config('bot.live');
        $bal = $rt['balance']['available'] ?? 0;
        if ($bal < $s['min_balance']) {
            $rt['status'] = sprintf('Saldo tersedia %.2f USDT di bawah minimum %.2f.', $bal, $s['min_balance']);

            return;
        }
        if ($live) {
            if ($this->throttled($rt, 'hedge_check', $now, 300_000)) {
                $rt['hedge'] = $this->trader->isHedgeMode();
            }
            if ($rt['hedge'] ?? false) {
                $rt['status'] = 'Mode Hedge terdeteksi. Ubah akun ke One-way Mode, bot tidak mendukung Hedge.';
                $this->warnOnce($rt, 'hedge', $now, $rt['status']);

                return;
            }
            if ($this->trader->positions() !== []) {
                $rt['status'] = 'Ada posisi lain di akun (bukan dari bot). Bot menunggu sampai akun bersih.';
                $this->warnOnce($rt, 'other_pos', $now, $rt['status']);

                return;
            }
        }

        foreach ($this->candidates($s) as $c) {
            $a = $c['a'];
            $rules = $this->bn->rules($c['symbol']);
            $plan = Sizing::plan([
                'side' => $a['side'], 'entry' => (float) $a['price'], 'sl' => (float) $a['levels']['sl'], 'tp' => (float) $a['levels']['tp1'],
                'balance' => $bal, 'risk_pct' => (float) $s['risk_pct'], 'max_leverage' => (int) $s['max_leverage'],
                'target_usd' => $s['target_usd'] > 0 ? (float) $s['target_usd'] : null, 'rules' => $rules,
            ]);
            if (! $plan['ok']) {
                $this->warnOnce($rt, 'plan:'.$c['symbol'], $now, "{$c['symbol']} dilewati: {$plan['reason']}", 'info', 600_000);

                continue;
            }
            $desc = sprintf('%s %s conf %d | qty %s lev %dx | SL %s TP %s | rugi maks ~%.2f untung ~%.2f USDT',
                $a['side'], $c['symbol'], $a['confidence'], $plan['qty'], $plan['leverage'], $plan['sl'], $plan['tp'], $plan['loss_usd'], $plan['gain_usd']);
            if (! $live) {
                $rt['status'] = 'MODE LATIHAN (BOT_LIVE=false): tidak mengirim order.';
                $this->warnOnce($rt, 'dry', $now, 'Rencana (tanpa order): '.$desc, 'info', 120_000);

                return;
            }
            if ($this->open($c['symbol'], $a, $plan, $rt, $now, $desc)) {
                return;
            }
        }
        $rt['status'] = 'Belum ada setup yang lolos. Bot terus memindai.';
    }

    /** @return list<array{symbol:string,a:array}> diurutkan confidence tertinggi */
    private function candidates(array $s): array
    {
        $out = [];
        foreach ($this->bn->symbols((int) $s['watchlist_size']) as $row) {
            try {
                $a = $this->analysis->run($row['symbol'], 'scalp');
            } catch (RuntimeException) {
                continue;
            }
            if ($a['side'] !== 'NEUTRAL' && ! empty($a['levels'])) {
                $out[] = ['symbol' => $row['symbol'], 'a' => $a];
            }
        }
        usort($out, fn ($x, $y) => $y['a']['confidence'] <=> $x['a']['confidence']);

        return array_slice($out, 0, 3);
    }

    private function open(string $sym, array $a, array $plan, array &$rt, int $now, string $desc): bool
    {
        $long = $a['side'] === 'LONG';
        $rules = $this->bn->rules($sym);
        $cid = 'bot'.substr(dechex($now), -9).bin2hex(random_bytes(3));

        $this->trader->setIsolated($sym);
        $lev = $this->trader->setLeverage($sym, $plan['leverage']);
        if ($lev !== $plan['leverage']) {
            BotEvent::log('warn', "$sym dilewati: Binance membatasi leverage ke {$lev}x (butuh {$plan['leverage']}x).");

            return false;
        }

        BotEvent::log('info', 'Membuka: '.$desc);
        $opened = $now;
        $mustExist = false;
        try {
            $res = $this->trader->market($sym, $long ? 'BUY' : 'SELL', $plan['qty'], false, $cid);
            $mustExist = (float) ($res['executedQty'] ?? 0) > 0 || ($res['status'] ?? '') === 'FILLED';
        } catch (BinanceApiException $e) {
            if (! $e->unknown) {
                BotEvent::log('error', "Order $sym ditolak: ".$e->getMessage());

                return false;
            }
            BotEvent::log('warn', "Hasil order $sym tidak pasti, memeriksa posisi di akun…");
        }

        // Bila order terisi, posisi pasti ada: tunggu lebih lama agar tidak pernah tertinggal tanpa SL.
        $pos = $this->findPosition($sym, $mustExist ? 20 : 5);
        if (! $pos) {
            if ($mustExist) {
                BotEvent::log('error', "Order $sym terisi tetapi posisi belum terbaca. PERIKSA DI BINANCE dan pasang SL manual bila ada posisi! Bot dihentikan.");
                $this->stopBot();
            }
            BotEvent::log('warn', "Tidak ada posisi $sym setelah order. Tidak ada yang dipasang.");

            return false;
        }
        $fill = (float) $pos['entryPrice'];
        $amt = abs((float) $pos['positionAmt']);
        $mark = (float) $pos['markPrice'];
        $closeSide = $long ? 'SELL' : 'BUY';

        // Geser level mengikuti harga isi sebenarnya, jarak SL/TP tetap.
        $slD = $plan['sl_dist'];
        $tpD = $plan['tp_dist'];
        $sl = $long ? Sizing::floorTo($fill - $slD, $rules['tick']) : Sizing::ceilTo($fill + $slD, $rules['tick']);
        $tp = $long ? Sizing::floorTo($fill + $tpD, $rules['tick']) : Sizing::ceilTo($fill - $tpD, $rules['tick']);

        $slOk = $long ? ($sl < $mark) : ($sl > $mark);
        $slId = '';
        if ($slOk) {
            $slId = $this->placeProtective($sym, $closeSide, 'STOP_MARKET', $sl, 'sl'.$cid);
        }
        if ($slId === '') {
            BotEvent::log('error', "SL $sym gagal dipasang. Posisi ditutup demi keamanan, bot dihentikan.");
            $this->forceClose($sym, $closeSide, $amt);
            $this->stopBot();
            $this->recordClosed($sym, $a['side'], $amt, $plan['leverage'], $fill, $sl, $tp, $opened, 'other', ['reason' => 'SL gagal dipasang']);

            return true;
        }
        $tpId = ($long ? $tp > $mark : $tp < $mark) ? $this->placeProtective($sym, $closeSide, 'TAKE_PROFIT_MARKET', $tp, 'tp'.$cid) : '';
        if ($tpId === '') {
            BotEvent::log('warn', "TP $sym tidak terpasang di Binance. Bot menutup manual saat harga mencapai $tp.");
        }

        BotTrade::create([
            'symbol' => $sym, 'side' => $a['side'], 'qty' => $amt, 'leverage' => $plan['leverage'], 'entry' => $fill, 'sl' => $sl, 'tp' => $tp,
            'status' => 'open', 'sl_algo_id' => $slId, 'tp_algo_id' => $tpId ?: null, 'opened_at' => $opened,
            'meta' => ['confidence' => $a['confidence'], 'plan' => $plan],
        ]);
        BotEvent::log('info', sprintf('Posisi terbuka %s %s @ %s. SL %s, TP %s terpasang di Binance. Bot memantau.', $a['side'], $sym, $fill, $sl, $tp));
        $rt['status'] = "Memantau posisi $sym";

        return true;
    }

    private function placeProtective(string $sym, string $closeSide, string $type, float $price, string $cid): string
    {
        for ($i = 0; $i < 2; $i++) {
            try {
                $id = $this->trader->conditional($sym, $closeSide, $type, $price, substr($cid, 0, 36));
                if ($id !== '') {
                    return $id;
                }
            } catch (BinanceApiException $e) {
                BotEvent::log('warn', "$type $sym gagal (percobaan ".($i + 1).'): '.$e->getMessage());
                usleep(300_000);
            }
        }

        return '';
    }

    private function findPosition(string $sym, int $tries = 5): ?array
    {
        for ($i = 0; $i < $tries; $i++) {
            foreach ($this->trader->positions($sym) as $p) {
                if ($p['symbol'] === $sym) {
                    return $p;
                }
            }
            usleep(500_000);
        }

        return null;
    }

    private function forceClose(string $sym, string $closeSide, float $qty): void
    {
        for ($i = 0; $i < 3; $i++) {
            try {
                $this->trader->market($sym, $closeSide, $qty, true, 'bc'.bin2hex(random_bytes(6)));

                return;
            } catch (BinanceApiException $e) {
                BotEvent::log('error', "Penutupan paksa $sym gagal: ".$e->getMessage().' — tutup manual di Binance bila posisi masih ada!');
                usleep(500_000);
            }
        }
    }

    // ---------------------------------------------------------------- pemantauan aktif

    private function manage(BotTrade $t, array $s, array &$rt, int $now): void
    {
        $sym = $t->symbol;
        $pos = null;
        foreach ($this->trader->positions($sym) as $p) {
            if ($p['symbol'] === $sym) {
                $pos = $p;
            }
        }
        if (! $pos) {
            $this->finalize($t, $s, $rt, $now);

            return;
        }

        $mark = (float) $pos['markPrice'];
        $long = $t->side === 'LONG';
        $closeSide = $long ? 'SELL' : 'BUY';
        $rules = $this->bn->rules($sym);
        $tpDist = abs($t->tp - $t->entry);
        $rt['status'] = "Memantau posisi $sym";
        $rt['position'] = [
            'symbol' => $sym, 'side' => $t->side, 'entry' => $t->entry, 'mark' => $mark, 'sl' => $t->sl, 'tp' => $t->tp,
            'qty' => abs((float) $pos['positionAmt']), 'leverage' => $t->leverage, 'pnl' => (float) $pos['unRealizedProfit'],
            'liq' => (float) $pos['liquidationPrice'], 'progress' => $tpDist > 0 ? round((($long ? 1 : -1) * ($mark - $t->entry)) / $tpDist, 3) : 0,
            'opened_at' => $t->opened_at, 'be_done' => $t->be_done, 'signal' => $rt['signal'] ?? null,
        ];

        // 1) Pengaman di Binance masih ada?
        if ($now - ($rt['last_guard'] ?? 0) >= self::GUARD_MS) {
            $rt['last_guard'] = $now;
            $this->ensureProtection($t, $closeSide, $mark, $rules, $long);
        }

        // 2) Analisis terbaru (sinyal berbalik?)
        if ($now - ($rt['last_signal'] ?? 0) >= self::SIGNAL_MS) {
            $rt['last_signal'] = $now;
            try {
                $a = $this->analysis->run($sym, 'scalp');
                $rt['signal'] = ['side' => $a['side'], 'lean' => $a['lean'], 'confidence' => $a['confidence']];
            } catch (RuntimeException) {
                // dipakai lagi pada siklus berikutnya
            }
        }

        // 3) Keputusan
        $d = Manager::decide(
            ['side' => $t->side, 'entry' => $t->entry, 'sl' => $t->sl, 'tp' => $t->tp, 'opened_at' => $t->opened_at, 'be_done' => $t->be_done],
            $mark, $now, $rt['signal'] ?? null,
            ['max_hold_min' => (int) $s['max_hold_min'], 'flip_confidence' => (int) $s['flip_confidence'], 'breakeven_at' => (float) $s['breakeven_at']],
            $rules['tick'],
        );

        if ($d['action'] === 'close') {
            $labels = ['tp' => 'harga mencapai TP', 'sl' => 'harga mencapai SL', 'time' => 'batas waktu posisi', 'signal' => 'sinyal berbalik'];
            BotEvent::log('info', "Menutup $sym: ".($labels[$d['reason']] ?? $d['reason']).'.');
            $meta = $t->meta ?? [];
            $meta['close_reason'] = $d['reason'];
            $t->meta = $meta;
            $t->save();
            $this->forceClose($sym, $closeSide, abs((float) $pos['positionAmt']));
            $rt['last_guard'] = 0;
        } elseif ($d['action'] === 'breakeven') {
            $this->moveSl($t, $closeSide, (float) $d['sl'], $rt);
        }
    }

    private function ensureProtection(BotTrade $t, string $closeSide, float $mark, array $rules, bool $long): void
    {
        try {
            $algos = $this->trader->openAlgo($t->symbol);
        } catch (BinanceApiException $e) {
            BotEvent::log('warn', 'Gagal memeriksa SL/TP di Binance: '.$e->getMessage());

            return;
        }
        $has = ['STOP_MARKET' => false, 'TAKE_PROFIT_MARKET' => false];
        foreach ($algos as $o) {
            $type = (string) ($o['orderType'] ?? $o['type'] ?? $o['origType'] ?? '');
            if (isset($has[$type])) {
                $has[$type] = true;
            }
        }
        // Format balasan tak dikenali: jangan memasang SL berulang-ulang, cukup beri tahu sekali.
        if ($algos !== [] && ! in_array(true, $has, true)) {
            BotEvent::log('warn', 'Daftar order SL/TP dari Binance tidak terbaca (format tak dikenali). Pemeriksaan SL dilewati; periksa SL di Binance.');

            return;
        }
        if (! $has['STOP_MARKET']) {
            $crossed = $long ? $mark <= $t->sl : $mark >= $t->sl;
            if ($crossed) {
                BotEvent::log('error', "SL {$t->symbol} hilang dan harga sudah melewatinya. Menutup posisi.");
                $this->forceClose($t->symbol, $closeSide, $t->qty);

                return;
            }
            BotEvent::log('warn', "SL {$t->symbol} tidak ditemukan di Binance. Memasang ulang.");
            $id = $this->placeProtective($t->symbol, $closeSide, 'STOP_MARKET', $t->sl, 'sr'.bin2hex(random_bytes(6)));
            if ($id === '') {
                BotEvent::log('error', "SL {$t->symbol} tidak bisa dipasang ulang. Menutup posisi demi keamanan.");
                $this->forceClose($t->symbol, $closeSide, $t->qty);

                return;
            }
            $t->sl_algo_id = $id;
            $t->save();
        }
        if (! $has['TAKE_PROFIT_MARKET'] && ($long ? $t->tp > $mark : $t->tp < $mark)) {
            $id = $this->placeProtective($t->symbol, $closeSide, 'TAKE_PROFIT_MARKET', $t->tp, 'tr'.bin2hex(random_bytes(6)));
            if ($id !== '') {
                $t->tp_algo_id = $id;
                $t->save();
            }
        }
    }

    /** Pasang SL baru dulu, baru batalkan yang lama, supaya posisi tidak pernah tanpa SL. */
    private function moveSl(BotTrade $t, string $closeSide, float $newSl, array &$rt): void
    {
        $id = $this->placeProtective($t->symbol, $closeSide, 'STOP_MARKET', $newSl, 'sm'.bin2hex(random_bytes(6)));
        if ($id === '') {
            BotEvent::log('warn', 'Gagal menggeser SL ke impas. SL lama tetap aktif.');
            $t->be_done = true; // jangan dicoba terus-menerus
            $t->save();

            return;
        }
        if ($t->sl_algo_id) {
            try {
                $this->trader->cancelAlgo($t->sl_algo_id);
            } catch (BinanceApiException) {
                BotEvent::log('warn', 'SL lama belum bisa dibatalkan; akan dibersihkan saat posisi selesai.');
            }
        }
        $t->sl = $newSl;
        $t->sl_algo_id = $id;
        $t->be_done = true;
        $t->save();
        BotEvent::log('info', "Harga sudah setengah jalan ke TP. SL digeser ke impas ($newSl) untuk {$t->symbol}.");
    }

    // ---------------------------------------------------------------- selesai & darurat

    private function finalize(BotTrade $t, array $s, array &$rt, int $now): void
    {
        try {
            $this->trader->cancelAllAlgo($t->symbol);
        } catch (BinanceApiException $e) {
            BotEvent::log('warn', "Pembersihan order sisa {$t->symbol} gagal: ".$e->getMessage().' — periksa di Binance.');
        }

        $realized = 0.0;
        $fees = 0.0;
        $exit = null;
        $n = 0;
        foreach ($this->trader->userTrades($t->symbol, $t->opened_at - 5_000) as $x) {
            $realized += (float) $x['realizedPnl'];
            $asset = (string) ($x['commissionAsset'] ?? 'USDT');
            $fees += in_array($asset, ['USDT', 'USDC', 'FDUSD', 'BUSD'], true)
                ? (float) $x['commission']
                : Sizing::FEE_SIDE * (float) $x['price'] * (float) $x['qty']; // fee dalam BNB: perkiraan
            if ((float) $x['realizedPnl'] != 0.0) {
                $exit = (float) $x['price'];
            }
            $n++;
        }
        $pnl = $realized - $fees;
        $reason = ($t->meta['close_reason'] ?? null);
        if (! $reason) {
            $exit ??= $t->entry;
            $reason = abs($exit - $t->tp) < abs($exit - $t->sl) ? 'tp' : 'sl';
            if ($pnl > 0 && $reason === 'sl') {
                $reason = 'other';
            }
        }
        $t->status = $reason;
        $t->exit_price = $exit;
        $t->pnl = round($pnl, 4);
        $t->closed_at = $now;
        $t->save();

        BotEvent::log($pnl >= 0 ? 'info' : 'warn', sprintf('Selesai %s %s (%s): %s%.4f USDT bersih.', $t->side, $t->symbol, $reason, $pnl >= 0 ? '+' : '', $pnl));
        $rt['position'] = null;
        $rt['last_scan'] = $now; // beri jeda sebelum mencari lagi
        $rt['last_guard'] = 0;
        $rt['signal'] = null;

        $row = BotTrade::where('status', '!=', 'open')->orderByDesc('id')->limit((int) $s['max_losses_row'])->pluck('pnl')->all();
        if (count($row) >= (int) $s['max_losses_row'] && max($row) < 0) {
            $rt['pause_until'] = $now + 3_600_000;
            BotEvent::log('warn', "{$s['max_losses_row']} rugi beruntun. Bot jeda 1 jam.");
        }
        $this->balanceNow($rt, $now);
    }

    private function panic(?BotTrade $t, array &$rt, int $now): void
    {
        BotEvent::log('warn', 'TOMBOL DARURAT ditekan.');
        if (! $t) {
            BotEvent::log('info', 'Tidak ada posisi dari bot. Bot dihentikan.');
            $rt['status'] = 'Berhenti (darurat).';

            return;
        }
        $meta = $t->meta ?? [];
        $meta['close_reason'] = 'panic';
        $t->meta = $meta;
        $t->save();
        $closeSide = $t->side === 'LONG' ? 'SELL' : 'BUY';
        $this->forceClose($t->symbol, $closeSide, $t->qty);
        usleep(600_000);
        $still = collect($this->trader->positions($t->symbol))->contains(fn ($p) => $p['symbol'] === $t->symbol);
        if (! $still) {
            $this->finalize($t, BotState::current()->settings, $rt, $now);
        } else {
            BotEvent::log('error', "Posisi {$t->symbol} masih terbuka setelah tombol darurat. TUTUP MANUAL di Binance sekarang.");
        }
        $rt['status'] = 'Berhenti (darurat).';
    }

    private function recordClosed(string $sym, string $side, float $qty, int $lev, float $entry, float $sl, float $tp, int $opened, string $status, array $meta): void
    {
        BotTrade::create([
            'symbol' => $sym, 'side' => $side, 'qty' => $qty, 'leverage' => $lev, 'entry' => $entry, 'sl' => $sl, 'tp' => $tp,
            'status' => $status, 'opened_at' => $opened, 'closed_at' => (int) (microtime(true) * 1000), 'meta' => $meta, 'pnl' => null,
        ]);
    }

    // ---------------------------------------------------------------- bantu

    private function refreshBalance(array &$rt, int $now): void
    {
        if ($now - ($rt['balance']['at'] ?? 0) < self::BALANCE_MS) {
            return;
        }
        $this->balanceNow($rt, $now);
    }

    private function balanceNow(array &$rt, int $now): void
    {
        try {
            $b = $this->trader->balance();
            $rt['balance'] = ['wallet' => $b['wallet'], 'available' => $b['available'], 'at' => $now];
        } catch (BinanceApiException $e) {
            $rt['balance_error'] = $e->getMessage();
        }
    }

    private function rollDay(array &$rt, int $now): void
    {
        $today = Carbon::createFromTimestampMs($now, config('bot.tz'))->format('Y-m-d');
        if (($rt['day']['date'] ?? null) !== $today && isset($rt['balance']['wallet'])) {
            $rt['day'] = ['date' => $today, 'start' => $rt['balance']['wallet']];
        }
    }

    private function dayPnl(array $rt): float
    {
        $start = Carbon::now(config('bot.tz'))->startOfDay()->getTimestampMs();

        return (float) BotTrade::where('status', '!=', 'open')->where('closed_at', '>=', $start)->sum('pnl');
    }

    private function throttled(array &$rt, string $key, int $now, int $everyMs): bool
    {
        if ($now - ($rt['t'][$key] ?? 0) < $everyMs) {
            return false;
        }
        $rt['t'][$key] = $now;

        return true;
    }

    private function warnOnce(array &$rt, string $key, int $now, string $msg, string $level = 'warn', int $everyMs = 300_000): void
    {
        if ($this->throttled($rt, 'log:'.$key, $now, $everyMs)) {
            BotEvent::log($level, $msg);
        }
    }

    /** Hanya menulis runtime dan detak jantung; saklar/pengaturan dari UI tidak pernah ditimpa dari sini. */
    private function save(BotState $st, array $rt, int $now): void
    {
        BotState::where('id', 1)->update(['runtime' => json_encode($rt), 'heartbeat' => $now]);
    }

    private function stopBot(): void
    {
        BotState::where('id', 1)->update(['enabled' => false]);
    }
}
