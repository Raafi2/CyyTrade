<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class IncomeRecord extends Model
{
    public $timestamps = false;

    protected $guarded = [];

    protected $casts = ['income' => 'float', 'time' => 'integer'];
}
