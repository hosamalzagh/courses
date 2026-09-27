<?php

namespace App\Support;

class StudentBarcode
{
    /** Code 39 patterns: nine alternating bars/spaces; 1 is wide, 0 is narrow. */
    private const array PATTERNS = [
        '0' => '000110100', '1' => '100100001', '2' => '001100001',
        '3' => '101100000', '4' => '000110001', '5' => '100110000',
        '6' => '001110000', '7' => '000100101', '8' => '100100100',
        '9' => '001100100', '*' => '010010100',
    ];

    public static function svg(int $number): string
    {
        $x = 10;
        $bars = '';
        foreach (str_split('*'.$number.'*') as $character) {
            foreach (str_split(self::PATTERNS[$character]) as $index => $wide) {
                $width = $wide === '1' ? 3 : 1;
                if ($index % 2 === 0) {
                    $bars .= '<rect x="'.$x.'" y="0" width="'.$width.'" height="60" />';
                }
                $x += $width;
            }
            $x++;
        }

        return '<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="'.$number.'" viewBox="0 0 '.($x + 9).' 60" width="'.(($x + 9) * 2).'" height="120"><rect width="100%" height="100%" fill="white"/><g fill="black">'.$bars.'</g></svg>';
    }
}
