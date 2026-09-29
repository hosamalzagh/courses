<?php

namespace App\Support;

class EffectiveStudentPayments
{
    public static function amount(string $paymentAlias = 'student_payments'): string
    {
        return "COALESCE((SELECT replacements.amount FROM student_payment_replacements AS replacements
            WHERE replacements.payment_id = {$paymentAlias}.id
              AND NOT EXISTS (SELECT 1 FROM student_payment_reversals AS next_reversals
                  WHERE next_reversals.prior_replacement_id = replacements.id)
            LIMIT 1), {$paymentAlias}.amount)";
    }
}
