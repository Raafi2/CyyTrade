<?php

namespace Tests\Unit;

use App\Services\Bot\Sizing;
use PHPUnit\Framework\TestCase;

class SizingTest extends TestCase
{
    private array $rules = ['tick' => 0.01, 'step' => 0.001, 'min_qty' => 0.001, 'min_notional' => 5.0];

    private function base(array $o = []): array
    {
        return $o + ['side' => 'LONG', 'entry' => 100.0, 'sl' => 99.5, 'tp' => 101.0, 'balance' => 9.0,
            'risk_pct' => 2.0, 'max_leverage' => 10, 'target_usd' => null, 'rules' => $this->rules];
    }

    public function test_rounding_helpers(): void
    {
        $this->assertSame(2, Sizing::decimals(0.01));
        $this->assertSame(0, Sizing::decimals(1.0));
        $this->assertSame(0.123, Sizing::floorTo(0.1239, 0.001));
        $this->assertSame(0.124, Sizing::ceilTo(0.1231, 0.001));
        $this->assertSame(99.99, Sizing::floorTo(99.999, 0.01));
    }

    public function test_risk_is_capped_and_leverage_derived(): void
    {
        $p = Sizing::plan($this->base());
        $this->assertTrue($p['ok'], $p['reason'] ?? '');
        // risiko 2% x 9 = 0,18; SL 0,5 => qty 0,36 (notional 36), leverage ceil(36 / 5,4) = 7
        $this->assertEqualsWithDelta(0.36, $p['qty'], 1e-9);
        $this->assertSame(7, $p['leverage']);
        $this->assertLessThanOrEqual(0.18 + 0.04, $p['loss_usd']);
        $this->assertLessThanOrEqual(9.0 * 0.6 + 1e-9, $p['margin']);
    }

    public function test_leverage_cap_reduces_size_not_risk_limit(): void
    {
        $p = Sizing::plan($this->base(['max_leverage' => 3]));
        $this->assertTrue($p['ok']);
        $this->assertLessThanOrEqual(3, $p['leverage']);
        $this->assertLessThanOrEqual(9.0 * 0.6 * 3 + 0.2, $p['notional']);
    }

    public function test_rejects_when_balance_too_small_for_min_notional(): void
    {
        $p = Sizing::plan($this->base(['balance' => 1.0, 'max_leverage' => 2, 'rules' => ['tick' => 0.1, 'step' => 0.001, 'min_qty' => 0.001, 'min_notional' => 100.0]]));
        $this->assertFalse($p['ok']);
    }

    public function test_every_accepted_plan_keeps_sl_well_inside_liquidation(): void
    {
        foreach ([5.0, 9.0, 50.0, 500.0] as $bal) {
            foreach ([0.2, 0.5, 1.0, 3.0] as $slDist) {
                foreach ([3, 10, 20] as $lev) {
                    $p = Sizing::plan($this->base(['balance' => $bal, 'sl' => 100.0 - $slDist, 'tp' => 100.0 + $slDist * 1.5, 'max_leverage' => $lev]));
                    if (! $p['ok']) {
                        continue;
                    }
                    $liqFrac = 1 / $p['leverage'] - Sizing::MMR;
                    $this->assertLessThanOrEqual(0.5 * $liqFrac + 1e-9, $p['sl_dist'] / 100.0);
                    $this->assertLessThanOrEqual($lev, $p['leverage']);
                    $this->assertLessThanOrEqual($bal * Sizing::MARGIN_FRAC + 1e-6, $p['margin']);
                    $this->assertLessThanOrEqual($bal * Sizing::HARD_RISK_PCT / 100 + 0.2 * 0.0 + $p['qty'] * 0.0 + 2 * Sizing::FEE_SIDE * $p['notional'] + 1e-6, $p['loss_usd']);
                }
            }
        }
    }

    public function test_wrong_side_and_unrealistic_target(): void
    {
        $this->assertFalse(Sizing::plan($this->base(['sl' => 100.5]))['ok']);
        $this->assertFalse(Sizing::plan($this->base(['target_usd' => 5.0]))['ok']);
        $this->assertFalse(Sizing::plan($this->base(['tp' => 100.1]))['ok']);
    }

    public function test_target_usd_sets_tp_distance_including_fees(): void
    {
        $p = Sizing::plan($this->base(['target_usd' => 0.30]));
        $this->assertTrue($p['ok'], $p['reason'] ?? '');
        $this->assertGreaterThan(0.30 - 0.02, $p['gain_usd']);
        $this->assertGreaterThan(100.0, $p['tp']);
    }

    public function test_short_levels_round_correctly(): void
    {
        $p = Sizing::plan($this->base(['side' => 'SHORT', 'sl' => 100.5, 'tp' => 99.0]));
        $this->assertTrue($p['ok'], $p['reason'] ?? '');
        $this->assertGreaterThan(100.0, $p['sl']);
        $this->assertLessThan(100.0, $p['tp']);
    }

    public function test_breakeven_sl_covers_fees(): void
    {
        $this->assertGreaterThan(100.0, Sizing::breakevenSl('LONG', 100.0, 0.01));
        $this->assertLessThan(100.0, Sizing::breakevenSl('SHORT', 100.0, 0.01));
    }
}
