<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class BotEvent extends Model
{
    public $timestamps = false;
    protected $guarded = [];

    public static function log(string $level, string $message): void
    {
        static::create(['time' => (int) (microtime(true) * 1000), 'level' => $level, 'message' => mb_substr($message, 0, 500)]);
        if (random_int(1, 40) === 1) {
            $keep = static::orderByDesc('id')->skip(500)->value('id');
            if ($keep) {
                static::where('id', '<=', $keep)->delete();
            }
        }
    }
}
