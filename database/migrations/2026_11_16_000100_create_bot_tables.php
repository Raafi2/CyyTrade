<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Satu baris (id = 1): saklar, pengaturan, kondisi berjalan, dan detak jantung proses bot.
        Schema::create('bot_state', function (Blueprint $t) {
            $t->unsignedTinyInteger('id')->primary();
            $t->boolean('enabled')->default(false);
            $t->boolean('panic')->default(false);
            $t->text('settings')->nullable();
            $t->text('runtime')->nullable();
            $t->unsignedBigInteger('heartbeat')->default(0);
        });

        Schema::create('bot_events', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('time')->index();
            $t->string('level', 8);
            $t->text('message');
        });

        Schema::create('bot_trades', function (Blueprint $t) {
            $t->id();
            $t->string('symbol', 24)->index();
            $t->string('side', 5);
            $t->double('qty');
            $t->unsignedSmallInteger('leverage');
            $t->double('entry');
            $t->double('sl');
            $t->double('tp');
            $t->double('exit_price')->nullable();
            $t->double('pnl')->nullable();          // bersih: PnL terealisasi dikurangi fee
            $t->string('status', 12)->default('open')->index(); // open|tp|sl|time|signal|manual|panic|other
            $t->boolean('be_done')->default(false);
            $t->string('sl_algo_id', 32)->nullable();
            $t->string('tp_algo_id', 32)->nullable();
            $t->unsignedBigInteger('opened_at')->index();
            $t->unsignedBigInteger('closed_at')->nullable();
            $t->text('meta')->nullable();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('bot_trades');
        Schema::dropIfExists('bot_events');
        Schema::dropIfExists('bot_state');
    }
};
