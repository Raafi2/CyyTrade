<?php

namespace Tests\Unit;

use App\Services\Analysis\SignalResolver;
use PHPUnit\Framework\TestCase;

/**
 * Resolver membaca urutan candle 1m (data nyata). Skenario di sini memakai candle tulis-tangan
 * hanya untuk memastikan aturan keputusan benar; tidak ada data pasar yang dibuat-buat di aplikasi.
 */
class SignalResolverTest extends TestCase
{
    private function c(float $h, float $l, ?float $close = null): array
    {
        return ['t' => 0, 'h' => $h, 'l' => $l, 'c' => $close ?? $h, 'ct' => 59_999];
    }

    // LONG: entry 100, SL 98 (risk 2), TP1 103 (1.5R), TP2 105 (2.5R)
    private function long(array $candles, int $maxBars = 2880): ?array
    {
        return SignalResolver::run('LONG', 100, 98, 103, 105, $candles, $maxBars);
    }

    public function test_long_kena_sl(): void
    {
        $r = $this->long([$this->c(100.5, 99.5), $this->c(100.2, 97.9)]);
        $this->assertSame('sl', $r['status']);
        $this->assertSame(-1.0, $r['r']);
        $this->assertSame(2, $r['bars']);
    }

    public function test_long_tp1_lalu_tp2(): void
    {
        $r = $this->long([$this->c(103.2, 100.5), $this->c(105.1, 103.0)]);
        $this->assertSame('tp2', $r['status']);
        $this->assertSame(2.0, $r['r']); // 0.5*1.5 + 0.5*2.5
    }

    public function test_long_tp1_lalu_kembali_ke_entry(): void
    {
        $r = $this->long([$this->c(103.2, 100.5), $this->c(104.0, 99.9)]);
        $this->assertSame('tp1', $r['status']);
        $this->assertSame(0.75, $r['r']); // 0.5*1.5, sisanya impas
    }

    public function test_sl_dan_tp1_di_candle_sama_dihitung_sl(): void
    {
        $r = $this->long([$this->c(104.0, 97.0)]);
        $this->assertSame('sl', $r['status']);
    }

    public function test_tp1_dan_tp2_satu_candle_tapi_menyentuh_entry_berhenti_di_tp1(): void
    {
        // low 99 < entry: urutan tidak pasti, asumsi terburuk = SL break-even kena dulu.
        $r = $this->long([$this->c(106.0, 99.0)]);
        $this->assertSame('tp1', $r['status']);
    }

    public function test_tp1_dan_tp2_satu_candle_tanpa_sentuh_entry_tp2(): void
    {
        $r = $this->long([$this->c(106.0, 100.4)]);
        $this->assertSame('tp2', $r['status']);
    }

    public function test_masih_terbuka_mengembalikan_null(): void
    {
        $this->assertNull($this->long([$this->c(101, 99.5), $this->c(101.5, 100)]));
    }

    public function test_kedaluwarsa_dihitung_mark_to_market(): void
    {
        $r = $this->long([$this->c(101.2, 99.8, 101.0)], 1);
        $this->assertSame('expired', $r['status']);
        $this->assertSame(0.5, $r['r']); // (101-100)/2
    }

    public function test_short_tp1_lalu_tp2(): void
    {
        $r = SignalResolver::run('SHORT', 100, 102, 97, 95, [$this->c(99.5, 96.9), $this->c(97.0, 94.9)], 2880);
        $this->assertSame('tp2', $r['status']);
        $this->assertSame(2.0, $r['r']);
    }

    public function test_short_kena_sl(): void
    {
        $r = SignalResolver::run('SHORT', 100, 102, 97, 95, [$this->c(102.1, 99.9)], 2880);
        $this->assertSame('sl', $r['status']);
    }

    public function test_risiko_nol_tidak_diselesaikan(): void
    {
        $this->assertNull(SignalResolver::run('LONG', 100, 100, 103, 105, [$this->c(101, 99)], 10));
    }
}
