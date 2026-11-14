<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('signals', function (Blueprint $t) {
            // r_result = hasil bersih (gross_r - cost_r), dalam R
            $t->decimal('gross_r', 7, 2)->nullable()->after('r_result');
            $t->decimal('cost_r', 7, 2)->nullable()->after('gross_r');
        });
    }

    public function down(): void
    {
        Schema::table('signals', function (Blueprint $t) {
            $t->dropColumn(['gross_r', 'cost_r']);
        });
    }
};
