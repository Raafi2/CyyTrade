<?php

use App\Http\Controllers\AnalysisController;
use Illuminate\Support\Facades\Route;

Route::get('/', fn () => view('app'));

Route::prefix('api')->group(function () {
    Route::get('/symbols', [AnalysisController::class, 'symbols']);
    Route::get('/analysis/{symbol}', [AnalysisController::class, 'analysis']);
    Route::get('/candles/{symbol}', [AnalysisController::class, 'candles']);
    Route::get('/history', [AnalysisController::class, 'history']);
});
