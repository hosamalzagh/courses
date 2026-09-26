<?php

namespace App\Support;

use Illuminate\Support\Facades\DB;

class CenterPermissions
{
    public const GRANTS = [
        'branch_manager' => ['description' => 'عرض بيانات الفرع وتعديلها. أدوار التشغيل والصلاحيات الإضافية تُمنح بصورة مستقلة.', 'label' => 'مدير الفرع', 'actions' => ['read', 'update']],
        'branch_viewer' => ['description' => 'عرض بيانات الفرع دون تعديل.', 'label' => 'عرض الفرع', 'actions' => ['read']],
        'branch_auditor' => ['description' => 'عرض الفرع وسجل تدقيقه.', 'label' => 'تدقيق الفرع', 'actions' => ['read', 'audit']],
        'registration' => ['description' => 'ملفات الطلاب والتسجيل ورسوم المحاولة بالسعر المعتمد والنقل والانتظار. الخصم يحتاج صلاحية إضافية.', 'label' => 'التسجيل', 'actions' => ['read', 'students.manage', 'enrollment.manage']],
        'attendance' => ['description' => 'تسجيل المحاضرات والحضور والإغلاق والتراجع عن آخر حضور شخصي في محاضرة مفتوحة وفق ضوابطه.', 'label' => 'الحضور', 'actions' => ['read', 'attendance.record', 'attendance.close', 'attendance.undo_own']],
        'academic_admin' => ['description' => 'الخطط والمجموعات والمحاضرون ومعادلة المحتوى وتصحيح الحضور المغلق وإلغاء اعتماد المحاضرة واعتماد إتمام الدراسة.', 'label' => 'الإدارة الأكاديمية', 'actions' => ['read', 'curriculum.manage', 'instructors.manage', 'attendance.correct', 'sessions.revoke', 'content.equivalence', 'study.complete']],
        'accounting' => ['description' => 'عرض الحركات المالية والدفعات والتخصيص والتصحيح. الاسترداد والتسوية يحتاجان الاعتماد المالي.', 'label' => 'الحسابات', 'actions' => ['read', 'payments.record', 'payments.allocate', 'payments.correct', 'finance.read']],
        'fee_discount' => ['description' => 'خصم رسوم محاولة الدراسة بسبب إلزامي ضمن التسجيل المخول؛ لا يمنح استردادًا أو تسوية.', 'label' => 'خصم الرسوم بسبب مسجل', 'actions' => ['fees.discount'], 'additional' => true],
        'financial_approval' => ['description' => 'اعتماد الاسترداد وتسوية الرسوم واستخدام الرصيد بين الفروع المصرح بها. يمنحها مالك المركز فقط.', 'label' => 'الاعتماد المالي: الاسترداد والتسوية واستخدام الرصيد بين الفروع', 'actions' => ['finance.approve'], 'additional' => true, 'owner_only' => true],
        'center_student_search' => ['description' => 'البحث عن البيانات الأساسية خارج الفروع المسندة عند تفعيل إعداد المركز؛ لا يكشف السجلات الدراسية أو المالية.', 'label' => 'البحث عن بيانات طلاب المركز الأساسية عند تفعيل الإتاحة', 'actions' => ['students.search_center'], 'additional' => true],
    ];

    public static function labels(): array
    {
        return [
            'center_owner' => 'مالك المركز', 'center_admin' => 'مسؤول المركز',
            ...array_map(fn (array $option): string => $option['label'], self::GRANTS),
        ];
    }

    public static function revision(array $centerRoles, array $branchRoles): string
    {
        sort($centerRoles);
        $branchRoles = array_filter($branchRoles);
        ksort($branchRoles);
        foreach ($branchRoles as &$roles) {
            $roles = array_values(array_unique($roles));
            sort($roles);
        }

        return hash('sha256', json_encode([$centerRoles, $branchRoles]));
    }

    public static function actions(array $roles): array
    {
        return array_values(array_unique(array_merge([], ...array_map(
            fn (string $role): array => self::GRANTS[$role]['actions'] ?? [], $roles,
        ))));
    }

    public function __construct(
        public array $centerRoles,
        public array $branchRoles,
    ) {}

    public static function forUser(int $userId): self
    {
        $rows = DB::connection('tenant')->table('center_grants')
            ->selectRaw('NULL::bigint AS branch_id, role')->where('user_id', $userId)
            ->unionAll(DB::connection('tenant')->table('branch_grants')
                ->select(['branch_id', 'role'])->where('user_id', $userId))
            ->get();
        $centerRoles = $rows->whereNull('branch_id')->pluck('role')->all();
        $branchRoles = $rows->whereNotNull('branch_id')->groupBy('branch_id')
            ->map(fn ($grants) => $grants->pluck('role')->all())->all();

        return new self($centerRoles, $branchRoles);
    }

    public function isCenterManager(): bool
    {
        return in_array('center_owner', $this->centerRoles, true)
            || in_array('center_admin', $this->centerRoles, true);
    }

    public function isOwner(): bool
    {
        return in_array('center_owner', $this->centerRoles, true);
    }

    public function can(string $action, int $branchId): bool
    {
        $knownActions = self::actions(array_keys(self::GRANTS));
        if (! in_array($action, $knownActions, true)) {
            return false;
        }

        return $this->isCenterManager()
            || in_array($action, self::actions($this->branchRoles[$branchId] ?? []), true);
    }

    public function toArray(): array
    {
        return [
            'center_roles' => $this->centerRoles,
            'branch_roles' => $this->branchRoles,
            'can_manage_center' => $this->isCenterManager(),
            'branch_actions' => array_map(fn (array $roles): array => self::actions($roles), $this->branchRoles),
            'center_actions' => $this->isCenterManager() ? self::actions(array_keys(self::GRANTS)) : [],
        ];
    }
}
