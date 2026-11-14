<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Signal extends Model
{
    protected $guarded = [];

    protected $casts = [
        'factors' => 'array',
        'reasons' => 'array',
        'opened_at' => 'datetime',
        'closed_at' => 'datetime',
        'entry' => 'float', 'sl' => 'float', 'tp1' => 'float', 'tp2' => 'float',
        'rr1' => 'float', 'rr2' => 'float', 'r_result' => 'float', 'gross_r' => 'float', 'cost_r' => 'float',
    ];
}
