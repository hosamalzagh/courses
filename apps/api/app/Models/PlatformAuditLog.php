<?php

namespace App\Models;

use App\Support\CenterPlans;
use App\Support\PlatformAudit;
use Illuminate\Database\Eloquent\Model;

class PlatformAuditLog extends Model
{
    protected $connection = 'central';

    public $timestamps = false;

    public const EVENTS = [
        'center.created' => 'إنشاء مركز',
        'center.updated' => 'تعديل بيانات المركز',
        'center.domain_changed' => 'تغيير نطاق المركز',
        'center.provisioning_retried' => 'إعادة تجهيز المركز',
        'platform_user.created' => 'إضافة موظف منصة',
        'platform_user.updated' => 'تعديل بيانات موظف منصة',
        'platform_user.role_changed' => 'تغيير دور موظف منصة',
    ];

    protected function casts(): array
    {
        return ['details' => 'array', 'created_at' => 'datetime'];
    }

    public function eventLabel(): string
    {
        return self::EVENTS[$this->event] ?? 'حدث غير مصنف';
    }

    public function actorLabel(): string
    {
        return $this->actor_name ?? $this->details['actor_name'] ?? 'منفذ غير متاح';
    }

    public function centerLabel(): string
    {
        return $this->center_name ?? $this->details['center_name'] ?? ($this->tenant_id ? 'مركز غير متاح' : 'إدارة المنصة');
    }

    public function localTime(): string
    {
        return $this->created_at->timezone('Africa/Cairo')->locale('ar')->translatedFormat('j F Y، g:i a');
    }

    /** @return array<string, array{before: mixed, after: mixed}> */
    public function safeChanges(): array
    {
        $changes = [];
        foreach (array_intersect_key($this->details['changes'] ?? [], PlatformAudit::FIELDS) as $field => $change) {
            if (is_array($change) && array_key_exists('before', $change) && array_key_exists('after', $change)
                && (is_scalar($change['before']) || $change['before'] === null)
                && (is_scalar($change['after']) || $change['after'] === null)) {
                $changes[$field] = $change;
            }
        }
        if ($changes === [] && $this->event === 'platform_user.role_changed'
            && isset($this->details['old_role'], $this->details['new_role'])) {
            $changes['platform_role'] = ['before' => $this->details['old_role'], 'after' => $this->details['new_role']];
        }

        return $changes;
    }

    public function summary(): string
    {
        $fields = array_keys($this->safeChanges());
        $fields = array_unique([...$fields, ...($this->details['changed_fields'] ?? $this->details['fields'] ?? [])]);
        $labels = [];
        foreach ($fields as $field) {
            if (isset(PlatformAudit::FIELDS[$field])) {
                $labels[] = PlatformAudit::FIELDS[$field];
            } elseif ($field === 'password') {
                $labels[] = 'كلمة المرور (القيم مخفية)';
            }
        }
        if ($labels !== []) {
            return ($this->safeChanges() ? 'تم تغيير: ' : 'الحقول المسجلة: ').implode('، ', $labels);
        }

        return match ($this->event) {
            'center.created' => 'تم إنشاء المركز وإرسال طلب التجهيز',
            'center.provisioning_retried' => 'تم إرسال طلب إعادة التجهيز',
            'center.domain_changed' => 'تم تحديث نطاق المركز',
            'platform_user.created' => 'تمت إضافة موظف إلى المنصة',
            default => 'تفاصيل التغيير المتاحة في السجل',
        };
    }

    public static function displayValue(string $field, mixed $value): string
    {
        if ($value === null || $value === '') {
            return 'غير مسجل';
        }
        if ($field === 'suspended') {
            return $value ? 'موقوف' : 'نشط';
        }
        if ($field === 'plan') {
            return CenterPlans::OPTIONS[$value] ?? 'خطة غير متاحة';
        }
        if (in_array($field, ['platform_role', 'role'], true)) {
            return match ($value) {
                'platform_owner' => 'مالك المنصة', 'platform_support' => 'دعم المنصة',
                default => 'دور غير متاح',
            };
        }

        return is_scalar($value) ? (string) $value : 'قيمة غير متاحة';
    }

    /** @return array<string, string> */
    public function contextDetails(): array
    {
        $rows = [];
        foreach (['user_name' => 'الموظف', 'domain' => 'النطاق', 'role' => 'الدور'] as $field => $label) {
            if (isset($this->details[$field])) {
                $rows[$label] = self::displayValue($field, $this->details[$field]);
            }
        }
        if (blank($this->details['user_name'] ?? null) && isset($this->details['user_id'])) {
            $rows['معرّف الموظف'] = self::displayValue('user_id', $this->details['user_id']);
        }
        if (in_array('password', $this->details['changed_fields'] ?? [], true)) {
            $rows['كلمة المرور'] = 'تم تغييرها؛ لا تُحفظ قيمتها في سجل المنصة';
        }

        return $rows;
    }
}
