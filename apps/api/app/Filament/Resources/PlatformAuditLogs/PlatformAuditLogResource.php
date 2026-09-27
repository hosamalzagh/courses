<?php

namespace App\Filament\Resources\PlatformAuditLogs;

use App\Filament\Resources\PlatformAuditLogs\Pages\ManagePlatformAuditLogs;
use App\Models\Center;
use App\Models\PlatformAuditLog;
use App\Models\User;
use BackedEnum;
use Carbon\CarbonImmutable;
use Filament\Actions\Action;
use Filament\Forms\Components\DatePicker;
use Filament\Forms\Components\Select;
use Filament\Resources\Resource;
use Filament\Support\Icons\Heroicon;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\Filter;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;
use Illuminate\Contracts\View\View;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;

class PlatformAuditLogResource extends Resource
{
    protected static ?string $model = PlatformAuditLog::class;

    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedClipboardDocumentList;

    protected static ?string $navigationLabel = 'سجل المنصة';

    protected static ?string $modelLabel = 'حدث منصة';

    protected static ?string $pluralModelLabel = 'سجل المنصة';

    public static function canViewAny(): bool
    {
        return auth()->user()?->platform_role === 'platform_owner';
    }

    public static function canCreate(): bool
    {
        return false;
    }

    public static function canEdit(Model $record): bool
    {
        return false;
    }

    public static function canDelete(Model $record): bool
    {
        return false;
    }

    public static function table(Table $table): Table
    {
        return $table
            ->columns([
                TextColumn::make('created_at')->label('الوقت · القاهرة')
                    ->visibleFrom('md')
                    ->formatStateUsing(fn (PlatformAuditLog $record): string => $record->localTime())
                    ->sortable(query: fn (Builder $query, string $direction): Builder => $query->orderBy('platform_audit_logs.created_at', $direction)),
                TextColumn::make('actor_id')->label('المنفذ')
                    ->state(fn (PlatformAuditLog $record): string => $record->actorLabel())->wrap()->visibleFrom('md'),
                TextColumn::make('event')->label('الحدث')
                    ->formatStateUsing(fn (PlatformAuditLog $record): string => $record->eventLabel())->wrap()->visibleFrom('md'),
                TextColumn::make('event_mobile')->label('الحدث والوقت')->hiddenFrom('md')
                    ->state(fn (PlatformAuditLog $record): string => $record->eventLabel())
                    ->description(fn (PlatformAuditLog $record): string => $record->localTime())->wrap(),
                TextColumn::make('tenant_id')->label('المركز')
                    ->state(fn (PlatformAuditLog $record): string => $record->centerLabel())->wrap(),
                TextColumn::make('details')->label('ملخص التغيير')
                    ->state(fn (PlatformAuditLog $record): string => $record->summary())->wrap()->limit(100)->visibleFrom('lg'),
            ])
            ->searchable()
            ->searchPlaceholder('مركز، منفذ، أو حدث')
            ->searchDebounce('300ms')
            ->headerActions([
                Action::make('clearSearch')->label('مسح البحث')->icon(Heroicon::OutlinedXMark)
                    ->visible(fn (ManagePlatformAuditLogs $livewire): bool => filled($livewire->tableSearch))
                    ->action(function (ManagePlatformAuditLogs $livewire): void {
                        $livewire->resetTableSearch();
                        $livewire->js('$nextTick(() => $wire.$el.querySelector("input[type=search]")?.focus())');
                    }),
            ])
            ->searchUsing(function (Builder $query, string $search): void {
                $events = array_keys(array_filter(PlatformAuditLog::EVENTS, fn (string $label): bool => str_contains($label, $search)));
                $query->where(function (Builder $query) use ($search, $events): void {
                    $query->where('audit_actors.name', 'ilike', '%'.$search.'%')
                        ->orWhere('audit_centers.name', 'ilike', '%'.$search.'%')
                        ->orWhere('platform_audit_logs.details->actor_name', 'ilike', '%'.$search.'%')
                        ->orWhere('platform_audit_logs.details->center_name', 'ilike', '%'.$search.'%')
                        ->orWhere('platform_audit_logs.event', 'ilike', '%'.$search.'%')
                        ->orWhereIn('platform_audit_logs.event', $events);
                });
            })
            ->filters([
                SelectFilter::make('event')->label('نوع الحدث')->native(false)
                    ->options(PlatformAuditLog::EVENTS),
                SelectFilter::make('tenant_id')->label('المركز')->native(false)->searchable()
                    ->modifyFormFieldUsing(fn (Select $field): Select => $field->searchDebounce(300)->noOptionsMessage('اكتب اسم المركز للبحث'))
                    ->getSearchResultsUsing(fn (string $search): array => Center::query()->where('name', 'ilike', '%'.$search.'%')
                        ->orderBy('name')->limit(50)->pluck('name', 'id')->all())
                    ->getOptionLabelUsing(fn ($value): ?string => Center::query()->whereKey($value)->value('name'))
                    ->indicateUsing(fn (array $state): ?string => filled($state['value'] ?? null) ? 'المركز المحدد' : null),
                SelectFilter::make('actor_id')->label('المنفذ')->native(false)->searchable()
                    ->modifyFormFieldUsing(fn (Select $field): Select => $field->searchDebounce(300)->noOptionsMessage('اكتب اسم المنفذ للبحث'))
                    ->getSearchResultsUsing(fn (string $search): array => User::query()->where('name', 'ilike', '%'.$search.'%')
                        ->whereIn('id', PlatformAuditLog::query()->select('actor_id'))
                        ->orderBy('name')->limit(50)->pluck('name', 'id')->all())
                    ->getOptionLabelUsing(fn ($value): ?string => User::query()->whereKey($value)->value('name'))
                    ->indicateUsing(fn (array $state): ?string => filled($state['value'] ?? null) ? 'المنفذ المحدد' : null),
                Filter::make('period')->label('الفترة · بتوقيت القاهرة')
                    ->schema([
                        DatePicker::make('from')->label('من تاريخ')->native(false)->displayFormat('d/m/Y')->locale('ar'),
                        DatePicker::make('until')->label('إلى تاريخ')->native(false)->displayFormat('d/m/Y')->locale('ar'),
                    ])
                    ->query(function (Builder $query, array $data): Builder {
                        foreach (['from', 'until'] as $field) {
                            $value = $data[$field] ?? null;
                            if (blank($value)) {
                                continue;
                            }
                            if (! is_string($value) || ! CarbonImmutable::canBeCreatedFromFormat($value, 'Y-m-d')) {
                                return $query->whereRaw('1 = 0');
                            }
                            $date = CarbonImmutable::createFromFormat('!Y-m-d', $value, 'Africa/Cairo');
                            $query->where('platform_audit_logs.created_at', $field === 'from' ? '>=' : '<',
                                ($field === 'from' ? $date : $date->addDay())->utc());
                        }

                        return $query;
                    })
                    ->indicateUsing(fn (array $state): ?string => filled($state['from'] ?? null) || filled($state['until'] ?? null)
                        ? 'الفترة: '.($state['from'] ?? 'البداية').' — '.($state['until'] ?? 'الآن') : null),
            ])
            ->recordActions([
                Action::make('details')->label('عرض التفاصيل')->icon(Heroicon::OutlinedEye)
                    ->modalHeading(fn (PlatformAuditLog $record): string => $record->eventLabel())
                    ->modalContent(fn (PlatformAuditLog $record): View => view('filament.platform-audit-details', ['record' => $record]))
                    ->modalSubmitAction(false)->modalCancelActionLabel('إغلاق'),
            ])
            ->emptyStateHeading('لا توجد سجلات مطابقة')
            ->emptyStateDescription('جرّب تغيير البحث أو إزالة بعض الفلاتر.')
            ->defaultSort('platform_audit_logs.created_at', 'desc');
    }

    public static function getEloquentQuery(): Builder
    {
        return parent::getEloquentQuery()
            ->leftJoin('users as audit_actors', 'audit_actors.id', '=', 'platform_audit_logs.actor_id')
            ->leftJoin('tenants as audit_centers', 'audit_centers.id', '=', 'platform_audit_logs.tenant_id')
            ->select('platform_audit_logs.*', 'audit_actors.name as actor_name', 'audit_centers.name as center_name');
    }

    public static function getPages(): array
    {
        return [
            'index' => ManagePlatformAuditLogs::route('/'),
        ];
    }
}
