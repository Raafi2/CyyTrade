<?php

namespace Tests\Unit;

use App\Services\Bot\Manager;
use PHPUnit\Framework\TestCase;

class ManagerTest extends TestCase
{
    private array $cfg = ['max_hold_min' => 20, 'flip_confidence' => 65, 'breakeven_at' => 0.5];

    private function trade(string $side = 'LONG'): array
    {
        return $side === 'LONG'
            ? ['side' => 'LONG', 'entry' => 100.0, 'sl' => 99.0, 'tp' => 102.0, 'opened_at' => 1_000_000, 'be_done' => false]
            : ['side' => 'SHORT', 'entry' => 100.0, 'sl' => 101.0, 'tp' => 98.0, 'opened_at' => 1_000_000, 'be_done' => false];
    }

    private function d(array $t, float $mark, int $now = 1_060_000, ?array $sig = null): array
    {
        return Manager::decide($t, $mark, $now, $sig, $this->cfg, 0.01);
    }

    public function test_hold_in_normal_range(): void
    {
        $this->assertSame('hold', $this->d($this->trade(), 100.3)['action']);
    }

    public function test_backup_close_when_tp_or_sl_crossed(): void
    {
        $this->assertSame('tp', $this->d($this->trade(), 102.1)['reason']);
        $this->assertSame('sl', $this->d($this->trade(), 98.9)['reason']);
        $this->assertSame('tp', $this->d($this->trade('SHORT'), 97.9)['reason']);
        $this->assertSame('sl', $this->d($this->trade('SHORT'), 101.1)['reason']);
    }

    public function test_time_stop(): void
    {
        $r = $this->d($this->trade(), 100.2, 1_000_000 + 21 * 60_000);
        $this->assertSame('close', $r['action']);
        $this->assertSame('time', $r['reason']);
    }

    public function test_signal_flip_closes_only_when_strong_and_opposite(): void
    {
        $this->assertSame('signal', $this->d($this->trade(), 99.8, 1_060_000, ['side' => 'SHORT', 'confidence' => 70])['reason']);
        $this->assertSame('hold', $this->d($this->trade(), 99.8, 1_060_000, ['side' => 'SHORT', 'confidence' => 60])['action']);
        $this->assertSame('hold', $this->d($this->trade(), 99.8, 1_060_000, ['side' => 'NEUTRAL', 'confidence' => 90])['action']);
        $this->assertSame('hold', $this->d($this->trade(), 99.8, 1_060_000, ['side' => 'LONG', 'confidence' => 90])['action']);
    }

    public function test_breakeven_moves_sl_up_for_long_and_down_for_short(): void
    {
        $r = $this->d($this->trade(), 101.2);
        $this->assertSame('breakeven', $r['action']);
        $this->assertGreaterThan(100.0, $r['sl']);
        $this->assertLessThan(101.2, $r['sl']);

        $s = $this->d($this->trade('SHORT'), 98.8);
        $this->assertSame('breakeven', $s['action']);
        $this->assertLessThan(100.0, $s['sl']);
    }

    public function test_breakeven_not_repeated(): void
    {
        $t = $this->trade();
        $t['be_done'] = true;
        $this->assertSame('hold', $this->d($t, 101.2)['action']);
    }
}
