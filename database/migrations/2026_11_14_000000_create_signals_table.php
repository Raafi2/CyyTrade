<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('signals', function (Blueprint $t) {
            $t->id();
            $t->string('symbol', 24);
            $t->string('side', 5);                       // LONG | SHORT
            $t->unsignedTinyInteger('confidence');
            $t->smallInteger('bias');                    // -100..100
            $t->string('regime', 12)->nullable();
            $t->decimal('entry', 24, 8);
            $t->decimal('sl', 24, 8);
            $t->decimal('tp1', 24, 8);
            $t->decimal('tp2', 24, 8);
            $t->decimal('rr1', 6, 2);
            $t->decimal('rr2', 6, 2);
            $t->string('status', 10)->default('open');   // open | sl | tp1 | tp2 | expired
            $t->decimal('r_result', 7, 2)->nullable();   // hasil dalam R
            $t->json('factors')->nullable();
            $t->json('reasons')->nullable();
            $t->timestamp('opened_at');
            $t->timestamp('closed_at')->nullable();
            $t->timestamps();

            $t->index(['symbol', 'status']);
            $t->index('opened_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('signals');
    }
};
