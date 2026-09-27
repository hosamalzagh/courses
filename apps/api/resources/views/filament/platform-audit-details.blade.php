<div dir="rtl" class="space-y-6">
    <dl class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        @foreach (['الوقت · القاهرة' => $record->localTime(), 'المنفذ' => $record->actorLabel(), 'المركز' => $record->centerLabel()] as $label => $value)
            <div>
                <dt class="text-sm text-gray-500 dark:text-gray-400">{{ $label }}</dt>
                <dd class="mt-1 font-medium break-words">{{ $value }}</dd>
            </div>
        @endforeach
    </dl>

    <p>{{ $record->summary() }}</p>

    @if ($record->safeChanges() !== [])
        <div class="overflow-x-auto">
            <table class="w-full text-start text-sm">
                <caption class="sr-only">القيم قبل التغيير وبعده</caption>
                <thead>
                    <tr class="border-b border-gray-200 dark:border-gray-700">
                        <th scope="col" class="px-3 py-3 text-start">الحقل</th>
                        <th scope="col" class="px-3 py-3 text-start">قبل التغيير</th>
                        <th scope="col" class="px-3 py-3 text-start">بعد التغيير</th>
                    </tr>
                </thead>
                <tbody>
                    @foreach ($record->safeChanges() as $field => $change)
                        <tr class="border-b border-gray-200 dark:border-gray-700">
                            <th scope="row" class="px-3 py-3 text-start">{{ \App\Support\PlatformAudit::FIELDS[$field] }}</th>
                            <td class="px-3 py-3 break-words"><bdi>{{ $record::displayValue($field, $change['before']) }}</bdi></td>
                            <td class="px-3 py-3 break-words"><bdi>{{ $record::displayValue($field, $change['after']) }}</bdi></td>
                        </tr>
                    @endforeach
                </tbody>
            </table>
        </div>
    @elseif (in_array($record->event, ['center.updated', 'center.domain_changed', 'platform_user.updated', 'platform_user.role_changed'], true))
        <p class="text-sm text-gray-500 dark:text-gray-400">القيم السابقة والجديدة غير مسجلة لهذا الحدث؛ نعرض المعلومات المتاحة فقط.</p>
    @endif

    @if ($record->contextDetails() !== [])
        <dl class="space-y-3">
            @foreach ($record->contextDetails() as $label => $value)
                <div>
                    <dt class="text-sm text-gray-500 dark:text-gray-400">{{ $label }}</dt>
                    <dd class="mt-1 break-words"><bdi>{{ $value }}</bdi></dd>
                </div>
            @endforeach
        </dl>
    @endif
</div>
