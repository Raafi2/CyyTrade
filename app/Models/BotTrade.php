<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class BotTrade extends Model
{
    public $timestamps = false;
    protected $guarded = [];
    protected $casts = [
        'qty' => 'float', 'entry' => 'float', 'sl' => 'float', 'tp' => 'float', 'exit_price' => 'float', 'pnl' => 'float',
        'be_done' => 'boolean', 'meta' => 'array', 'opened_at' => 'integer', 'closed_at' => 'integer',
    ];
}
