<?php

namespace Tests\Unit;

use App\Services\Analysis\Indicators;
use PHPUnit\Framework\TestCase;

class IndicatorsTest extends TestCase
{
    public function test_ema_dari_deret_naik_berada_di_bawah_harga_terakhir(): void
    {
        $ema = Indicators::ema(range(1, 10), 3);
        $this->assertEqualsWithDelta(9.0, end($ema), 0.0001);
    }

    public function test_rsi_ekstrem(): void
    {
        $up = Indicators::rsi(range(1, 30), 14);
        $down = Indicators::rsi(array_reverse(range(1, 30)), 14);
        $this->assertEqualsWithDelta(100.0, end($up), 0.0001);
        $this->assertEqualsWithDelta(0.0, end($down), 0.0001);
    }
}
