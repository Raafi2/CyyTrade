<?php

use App\Http\Controllers\AnalysisController;
use Illuminate\Support\Facades\Route;

// Awalan /api ditambahkan otomatis. Tanpa session/cookie; dibatasi per IP.
Route::middleware('throttle:300,1')->group(function () {
    Route::get('/symbols', [AnalysisController::class, 'symbols']);
    Route::get('/analysis/{symbol}', [AnalysisController::class, 'analysis']);
    Route::get('/candles/{symbol}', [AnalysisController::class, 'candles']);
    Route::get('/history', [AnalysisController::class, 'history']);
    Route::get('/track', [AnalysisController::class, 'track']);
});
