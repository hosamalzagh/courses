<?php

namespace App\Support;

use InvalidArgumentException;

class StudentMoney
{
    public static function cents(string|int|float $value): int
    {
        $text = (string) $value;
        if (! preg_match('/^\d{1,15}(?:\.\d{1,2})?$/', $text)) {
            throw new InvalidArgumentException('Invalid student money amount.');
        }
        [$whole, $fraction] = array_pad(explode('.', $text, 2), 2, '');

        return ((int) $whole) * 100 + (int) str_pad($fraction, 2, '0');
    }

    public static function format(int $cents): string
    {
        if ($cents < 0) {
            throw new InvalidArgumentException('Negative student money balance.');
        }

        return intdiv($cents, 100).'.'.str_pad((string) ($cents % 100), 2, '0', STR_PAD_LEFT);
    }
}
