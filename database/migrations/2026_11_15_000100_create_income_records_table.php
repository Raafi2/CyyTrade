<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /** Salinan lokal income akun (PnL, fee, funding, transfer) supaya riwayat melebihi batas ~3 bulan dari Binance. */
    public function up(): void
    {
        Schema::create('income_records', function (Blueprint $t) {
            $t->id();
            $t->string('type', 24);
            $t->string('tran_id', 64);
            $t->string('symbol', 24)->default('');
            $t->double('income');
            $t->unsignedBigInteger('time')->index();
            $t->unique(['type', 'tran_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('income_records');
    }
};
