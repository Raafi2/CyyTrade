<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class BotState extends Model
{
    protected $table = 'bot_state';
    public $timestamps = false;
    public $incrementing = false;
    protected $guarded = [];
    protected $casts = ['enabled' => 'boolean', 'panic' => 'boolean', 'settings' => 'array', 'runtime' => 'array', 'heartbeat' => 'integer'];

    public static function current(): self
    {
        $s = static::find(1);
        if (! $s) {
            $s = static::create(['id' => 1, 'enabled' => false, 'panic' => false, 'settings' => config('bot.defaults'), 'runtime' => [], 'heartbeat' => 0]);
        }
        // Pengaturan yang belum ada memakai bawaan.
        $s->settings = array_merge(config('bot.defaults'), $s->settings ?? []);

        return $s;
    }
}
