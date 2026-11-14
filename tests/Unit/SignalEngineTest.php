<?php

namespace Tests\Unit;

use App\Services\Analysis\SignalEngine;
use PHPUnit\Framework\TestCase;

/**
 * Tes struktur dan guard engine. Deret candle sintetis di sini hanya untuk menguji kontrak
 * keluaran engine (bentuk hasil, veto, data kurang), bukan untuk menilai performa strategi.
 */
class SignalEngineTest extends TestCase
{
    private function series(int $n, int $stepMs, float $start, float $drift, float $amp, int $period): array
    {
        $out = [];
        $t = 1_700_000_000_000;
        $p = $start;
        for ($i = 0; $i < $n; $i++) {
            $o = $p;
            $p = $start + $drift * $i + $amp * sin($i * 2 * M_PI / $period);
            $out[] = [
                't' => $t + $i * $stepMs, 'o' => $o, 'h' => max($o, $p) + $amp * 0.2, 'l' => min($o, $p) - $amp * 0.2,
                'c' => $p, 'v' => 1000 + ($i % 7) * 50, 'qv' => 0, 'ct' => $t + ($i + 1) * $stepMs - 1,
            ];
        }

        return $out;
    }

    private function engine(): SignalEngine
    {
        return new SignalEngine(require __DIR__.'/../../config/signal.php');
    }

    public function test_data_kurang_menghasilkan_netral_dengan_veto(): void
    {
        $c = $this->series(300, 900_000, 100, 0.01, 0.4, 20);
        $h = $this->series(300, 3_600_000, 100, 0.05, 1.2, 24);
        $f = $this->series(300, 14_400_000, 100, 0.2, 3, 18);

        $r = $this->engine()->analyze('TESTUSDT', array_slice($c, 0, 10), $h, $f, 100.0);

        $this->assertSame('NEUTRAL', $r['side']);
        $this->assertNotEmpty($r['vetoes']);
    }

    public function test_hasil_lengkap_punya_kontrak_yang_dipakai_ui(): void
    {
        $c = $this->series(300, 900_000, 100, 0.01, 0.4, 20);
        $h = $this->series(300, 3_600_000, 100, 0.05, 1.2, 24);
        $f = $this->series(300, 14_400_000, 100, 0.2, 3, 18);

        $r = $this->engine()->analyze('TESTUSDT', $c, $h, $f, end($c)['c']);

        foreach (['side', 'lean', 'bias', 'confidence', 'regime', 'levels', 'factors', 'reasons', 'vetoes'] as $k) {
            $this->assertArrayHasKey($k, $r);
        }
        $this->assertContains($r['side'], ['LONG', 'SHORT', 'NEUTRAL']);
        $this->assertGreaterThanOrEqual(0, $r['confidence']);
        $this->assertLessThanOrEqual(100, $r['confidence']);
    }

    public function test_sinyal_aktif_selalu_punya_level_yang_konsisten(): void
    {
        $c = $this->series(300, 900_000, 100, 0.01, 0.4, 20);
        $h = $this->series(300, 3_600_000, 100, 0.05, 1.2, 24);
        $f = $this->series(300, 14_400_000, 100, 0.2, 3, 18);

        $r = $this->engine()->analyze('TESTUSDT', $c, $h, $f, end($c)['c']);
        $l = $r['levels'];
        if ($l === null || $r['lean'] === 'NEUTRAL') {
            $this->markTestSkipped('Tidak ada level pada deret uji ini.');
        }
        if ($r['lean'] === 'LONG') {
            $this->assertLessThan($l['entry'], $l['sl']);
            $this->assertGreaterThan($l['entry'], $l['tp1']);
            $this->assertGreaterThan($l['tp1'], $l['tp2']);
        } else {
            $this->assertGreaterThan($l['entry'], $l['sl']);
            $this->assertLessThan($l['entry'], $l['tp1']);
            $this->assertLessThan($l['tp1'], $l['tp2']);
        }
    }
}
