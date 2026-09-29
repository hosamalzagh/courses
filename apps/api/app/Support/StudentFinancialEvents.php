<?php

namespace App\Support;

use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

final class StudentFinancialEvents
{
    public const TYPES = ['allocation_correction', 'fee_adjustment', 'refund', 'refund_correction', 'payment_correction'];

    public static function page(string $studentId, CenterPermissions $permissions, int $page, ?string $focusType = null, ?string $focusId = null): Builder
    {
        $db = DB::connection('tenant');
        $readable = self::readableBranches($permissions);

        $fee = $db->table('study_fee_adjustments as event')
            ->leftJoin('study_fee_adjustments as successor', 'successor.replaces_id', '=', 'event.id')
            ->leftJoin('study_fee_adjustments as correction', function ($join): void {
                $join->on('correction.submission_id', '=', 'event.submission_id')
                    ->where('event.kind', 'reversal')->where('correction.kind', 'settlement');
            })
            ->where('event.student_id', $studentId)
            ->when($readable !== null, fn (Builder $query) => $query->whereIn('event.branch_id', $readable)
                ->whereNotExists($db->table('study_fee_adjustment_related_branches as related')
                    ->whereColumn('related.adjustment_id', 'event.id')
                    ->whereNotIn('related.branch_id', $readable)->selectRaw('1')))
            ->selectRaw("'fee_adjustment'::text AS event_type, event.id AS event_id, event.branch_id, event.branch_id AS related_branch_id, NULL::bigint AS second_related_branch_id, NULL::uuid AS payment_id, event.fee_id, event.before_due::text AS amount_before, event.after_due::text AS amount_after, event.reason, event.actor_name, event.created_at, COALESCE(event.reverses_id, event.replaces_id) AS original_id, COALESCE(successor.id, correction.id) AS replacement_id, (SELECT COALESCE(jsonb_agg(related.branch_id), '[]'::jsonb) FROM study_fee_adjustment_related_branches AS related WHERE related.adjustment_id = event.id) AS related_branch_ids");

        $refund = $db->table('student_refunds as event')->where('event.student_id', $studentId)
            ->when($readable !== null, fn (Builder $query) => $query->whereIn('event.branch_id', $readable))
            ->selectRaw("'refund'::text AS event_type, event.id AS event_id, event.branch_id, event.branch_id AS related_branch_id, NULL::bigint AS second_related_branch_id, event.payment_id, NULL::uuid AS fee_id, '0.00'::text AS amount_before, event.amount::text AS amount_after, event.reason, event.actor_name, event.created_at, NULL::uuid AS original_id, NULL::uuid AS replacement_id, NULL::jsonb AS related_branch_ids");

        $refundCorrection = $db->table('student_refund_reversals as event')
            ->join('student_refunds as original', 'original.id', '=', 'event.refund_id')
            ->leftJoin('student_refunds as replacement', 'replacement.submission_id', '=', 'event.submission_id')
            ->where('event.student_id', $studentId)
            ->when($readable !== null, fn (Builder $query) => $query->whereIn('original.branch_id', $readable))
            ->selectRaw("'refund_correction'::text AS event_type, event.id AS event_id, original.branch_id, original.branch_id AS related_branch_id, NULL::bigint AS second_related_branch_id, original.payment_id, NULL::uuid AS fee_id, original.amount::text AS amount_before, COALESCE(replacement.amount, 0.00::numeric(12, 2))::text AS amount_after, event.reason, event.actor_name, event.created_at, original.id AS original_id, replacement.id AS replacement_id, NULL::jsonb AS related_branch_ids");

        $paymentCorrection = $db->table('student_payment_reversals as event')
            ->join('student_payments as payment', 'payment.id', '=', 'event.payment_id')
            ->join('student_payment_replacements as replacement', 'replacement.reversal_id', '=', 'event.id')
            ->leftJoin('student_payment_replacements as prior', 'prior.id', '=', 'event.prior_replacement_id')
            ->where('payment.student_id', $studentId)
            ->when($readable !== null, function (Builder $query) use ($db, $readable): void {
                $query->whereIn('payment.branch_id', $readable)->whereNotExists($db->table('student_payment_correction_allocations as links')
                    ->join('student_payment_allocations as original', 'original.id', '=', 'links.original_allocation_id')
                    ->whereColumn('links.payment_reversal_id', 'event.id')
                    ->whereNotIn('original.target_branch_id', $readable)->selectRaw('1'));
            })
            ->selectRaw("'payment_correction'::text AS event_type, event.id AS event_id, payment.branch_id, payment.branch_id AS related_branch_id, NULL::bigint AS second_related_branch_id, payment.id AS payment_id, NULL::uuid AS fee_id, COALESCE(prior.amount, payment.amount)::text AS amount_before, replacement.amount::text AS amount_after, event.reason, event.actor_name, event.created_at, COALESCE(event.prior_replacement_id, payment.id) AS original_id, replacement.id AS replacement_id, (SELECT COALESCE(jsonb_agg(DISTINCT original.target_branch_id), '[]'::jsonb) FROM student_payment_correction_allocations AS links JOIN student_payment_allocations AS original ON original.id = links.original_allocation_id WHERE links.payment_reversal_id = event.id) AS related_branch_ids");

        $allocationCorrection = $db->table('student_payment_allocation_reversals as event')
            ->join('student_allocation_submissions as submission', 'submission.request_id', '=', 'event.submission_id')
            ->join('student_payment_allocations as original', 'original.id', '=', 'event.allocation_id')
            ->leftJoin('student_payment_allocations as replacement', 'replacement.submission_id', '=', 'event.submission_id')
            ->where('event.student_id', $studentId)->where('submission.kind', 'correct')
            ->when($readable !== null, fn (Builder $query) => $query->whereIn('original.source_branch_id', $readable)
                ->whereIn('original.target_branch_id', $readable)
                ->where(fn (Builder $visible) => $visible->whereNull('replacement.id')->orWhereIn('replacement.target_branch_id', $readable)))
            ->selectRaw("'allocation_correction'::text AS event_type, event.id AS event_id, original.source_branch_id AS branch_id, original.target_branch_id AS related_branch_id, replacement.target_branch_id AS second_related_branch_id, original.payment_id, original.fee_id, original.amount::text AS amount_before, COALESCE(replacement.amount, 0.00::numeric(12, 2))::text AS amount_after, event.reason, event.actor_name, event.created_at, original.id AS original_id, replacement.id AS replacement_id, NULL::jsonb AS related_branch_ids");

        $union = $fee->unionAll($refund)->unionAll($refundCorrection)->unionAll($paymentCorrection)->unionAll($allocationCorrection);

        return $db->query()->fromSub($union, 'events')
            ->when($focusType !== null && $focusId !== null, fn (Builder $query) => $query
                ->where('events.event_type', $focusType)->where('events.event_id', $focusId))
            ->orderByDesc('events.created_at')->orderByDesc('events.event_id')
            ->offset($focusId === null ? ($page - 1) * 20 : 0)->limit($focusId === null ? 21 : 1);
    }

    private static function readableBranches(CenterPermissions $permissions): ?array
    {
        if ($permissions->isCenterManager()) {
            return null;
        }

        return array_keys(array_filter($permissions->branchRoles,
            fn (array $roles): bool => in_array('finance.read', CenterPermissions::actions($roles), true)));
    }
}
