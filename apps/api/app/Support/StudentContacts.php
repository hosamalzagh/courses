<?php

namespace App\Support;

use App\Http\Controllers\CenterStudentSearchController;
use Illuminate\Database\Query\Builder;
use Illuminate\Validation\ValidationException;

class StudentContacts
{
    public const CHANNELS = ['primary', 'alternative', 'whatsapp', 'sinjapp'];

    public static function rules(): array
    {
        $rules = [
            'contacts' => ['present_with:channels', 'array', 'list', 'max:20'],
            'contacts.*' => ['required', 'array:id,name,relationship,phone,primary'],
            'contacts.*.id' => ['required', 'uuid', 'distinct:strict'],
            'contacts.*.name' => ['required', 'string', 'max:255'],
            'contacts.*.relationship' => ['required', 'string', 'max:100'],
            'contacts.*.phone' => ['required', 'string', 'max:50', 'regex:/[0-9٠-٩۰-۹]/u'],
            'contacts.*.primary' => ['required', 'boolean'],
            'channels' => ['present_with:contacts', 'array:primary,alternative,whatsapp,sinjapp'],
        ];
        foreach (self::CHANNELS as $channel) {
            $rules["channels.$channel"] = ['sometimes', 'nullable', 'array:contact_id,phone'];
            $rules["channels.$channel.contact_id"] = ['required_with:channels.'.$channel, 'uuid'];
            $rules["channels.$channel.phone"] = ['required_with:channels.'.$channel, 'string', 'max:50', 'regex:/[0-9٠-٩۰-۹]/u'];
        }

        return $rules;
    }

    public static function normalize(array $data): array
    {
        if (! array_key_exists('contacts', $data)) {
            return $data;
        }
        $contacts = array_map(function (array $contact): array {
            foreach (['name', 'relationship', 'phone'] as $field) {
                $contact[$field] = trim($contact[$field]);
            }
            $contact['primary'] = (bool) $contact['primary'];

            return $contact;
        }, $data['contacts']);
        if ($contacts !== [] && count(array_filter($contacts, fn ($contact) => $contact['primary'])) !== 1) {
            throw ValidationException::withMessages(['contacts' => 'حدد جهة تواصل أساسية واحدة.']);
        }
        $channels = [];
        foreach (self::CHANNELS as $channel) {
            $value = $data['channels'][$channel] ?? null;
            if ($value !== null) {
                if (! in_array($value['contact_id'], array_column($contacts, 'id'), true)) {
                    throw ValidationException::withMessages(["channels.$channel.contact_id" => 'اختر صاحب القناة من جهات هذا الطالب.']);
                }
                $value['phone'] = trim($value['phone']);
            }
            $channels[$channel] = $value;
        }
        $data['contacts'] = $contacts;
        $data['channels'] = $channels;

        return $data;
    }

    public static function columns(array $data): array
    {
        if (! array_key_exists('contacts', $data)) {
            return [];
        }
        $phones = [...array_column($data['contacts'], 'phone'), ...array_column(array_filter($data['channels']), 'phone')];
        $phones = array_values(array_unique(array_filter(array_map(CenterStudentSearchController::normalizePhone(...), $phones), fn ($phone) => $phone !== null)));

        return ['contacts' => json_encode($data['contacts']), 'channels' => json_encode($data['channels']), 'contact_phones' => json_encode($phones)];
    }

    public static function phoneSql(): string
    {
        return "COALESCE(students.channels->'primary'->>'phone', (SELECT contact->>'phone' FROM jsonb_array_elements(students.contacts) contact WHERE contact->>'primary' = 'true' LIMIT 1), students.phone)";
    }

    public static function matchPhone(Builder $query, string $phone, bool $exact = false): void
    {
        $query->orWhere(function (Builder $rows) use ($phone, $exact): void {
            if ($exact) {
                $rows->where('phone_search', $phone)->orWhereRaw('contact_phones @> ?::jsonb', [json_encode([$phone])]);
            } else {
                $rows->whereRaw('strpos(phone_search, ?) > 0', [$phone])
                    ->orWhereRaw('EXISTS (SELECT 1 FROM jsonb_array_elements_text(contact_phones) number WHERE strpos(number, ?) > 0)', [$phone]);
            }
        });
    }
}
