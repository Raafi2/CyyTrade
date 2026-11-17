<?php

use App\Http\Controllers\AnalysisController;
use App\Http\Controllers\BotController;
use App\Http\Controllers\PortfolioController;
use Illuminate\Support\Facades\Route;

// Awalan /api ditambahkan otomatis. Tanpa session/cookie; dibatasi per IP.
Route::middleware('throttle:600,1')->group(function () {
    Route::get('/symbols', [AnalysisController::class, 'symbols']);
    Route::get('/analysis/{symbol}', [AnalysisController::class, 'analysis']);
    Route::get('/candles/{symbol}', [AnalysisController::class, 'candles']);
    Route::get('/history', [AnalysisController::class, 'history']);
    Route::get('/track', [AnalysisController::class, 'track']);
    Route::get('/bot', [BotController::class, 'state']);
    Route::post('/bot/settings', [BotController::class, 'settings']);
    Route::post('/bot/start', [BotController::class, 'start']);
    Route::post('/bot/stop', [BotController::class, 'stop']);
    Route::post('/bot/panic', [BotController::class, 'panic']);
    Route::get('/portfolio', [PortfolioController::class, 'portfolio']);
    Route::get('/portfolio/income', [PortfolioController::class, 'income']);
});
