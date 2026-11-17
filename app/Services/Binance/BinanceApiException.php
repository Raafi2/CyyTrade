<?php

namespace App\Services\Binance;

use RuntimeException;

/** Kegagalan permintaan akun/order ke Binance. $unknown = true bila hasil order tidak pasti (timeout/putus). */
class BinanceApiException extends RuntimeException
{
    public function __construct(string $message, public readonly int $binanceCode = 0, public readonly int $httpStatus = 0, public readonly bool $unknown = false)
    {
        parent::__construct($message);
    }
}
