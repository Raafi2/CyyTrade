<?php

use App\Http\Controllers\AnalysisController;
use App\Http\Controllers\PortfolioController;
use Illuminate\Support\Facades\Route;

// Awalan /api ditambahkan otomatis. Tanpa session/cookie; dibatasi per IP.
Route::middleware('throttle:600,1')->group(function () {
    Route::get('/symbols', [AnalysisController::class, 'symbols']);
    Route::get('/analysis/{symbol}', [AnalysisController::class, 'analysis']);
    Route::get('/candles/{symbol}', [AnalysisController::class, 'candles']);
    Route::get('/history', [AnalysisController::class, 'history']);
    Route::get('/track', [AnalysisController::class, 'track']);
    Route::get('/portfolio', [PortfolioController::class, 'portfolio']);
    Route::get('/portfolio/income', [PortfolioController::class, 'income']);
});
