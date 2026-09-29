<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('study_fee_adjustment_related_branches', function (Blueprint $table): void {
            $table->foreignUuid('adjustment_id')->constrained('study_fee_adjustments')->restrictOnDelete();
            $table->foreignId('branch_id')->constrained('branches')->restrictOnDelete();
            $table->primary(['adjustment_id', 'branch_id'], 'fee_adjustment_related_branches_primary');
        });

        // The existing approval audit is immutable and records every adjustment and released source branch.
        DB::statement(<<<'SQL'
INSERT INTO study_fee_adjustment_related_branches (adjustment_id, branch_id)
SELECT adjustment.id, branch.id
FROM center_audit_logs AS audit
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE((audit.details::jsonb)->'adjustment_ids', '[]'::jsonb)) AS adjustment_ids(id)
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE((audit.details::jsonb)->'related_branch_ids', '[]'::jsonb)) AS related_branches(id)
JOIN study_fee_adjustments AS adjustment ON adjustment.id::text = adjustment_ids.id
JOIN branches AS branch ON branch.id::text = related_branches.id
WHERE audit.event IN ('student.fee_settled', 'student.fee_settlement_corrected')
ON CONFLICT DO NOTHING
SQL);

        foreach (['study_fee_adjustments', 'student_refund_reversals', 'student_payment_allocation_reversals'] as $table) {
            Schema::table($table, function (Blueprint $blueprint) use ($table): void {
                $blueprint->index(['student_id', 'created_at', 'id'], "{$table}_student_created_id_idx");
            });
        }

        DB::statement('CREATE TRIGGER preserve_study_fee_adjustment_related_branches BEFORE UPDATE OR DELETE ON study_fee_adjustment_related_branches FOR EACH ROW EXECUTE FUNCTION preserve_study_fee_adjustment()');
    }

    public function down(): void
    {
        if (DB::table('study_fee_adjustments')->exists()) {
            throw new RuntimeException('Cannot roll back approved study fee adjustment branch visibility.');
        }

        DB::statement('DROP TRIGGER preserve_study_fee_adjustment_related_branches ON study_fee_adjustment_related_branches');
        foreach (['study_fee_adjustments', 'student_refund_reversals', 'student_payment_allocation_reversals'] as $table) {
            Schema::table($table, function (Blueprint $blueprint) use ($table): void {
                $blueprint->dropIndex("{$table}_student_created_id_idx");
            });
        }
        Schema::dropIfExists('study_fee_adjustment_related_branches');
    }
};
