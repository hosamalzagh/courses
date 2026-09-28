<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::unprepared(<<<'SQL'
CREATE OR REPLACE FUNCTION protect_used_plan_lecture() RETURNS trigger AS $$
DECLARE plan_id uuid;
DECLARE already_used timestamp;
DECLARE superseded boolean;
BEGIN
    plan_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.plan_version_id ELSE NEW.plan_version_id END;
    SELECT plans.used_at, EXISTS(SELECT 1 FROM study_plan_versions AS later WHERE later.level_id = plans.level_id AND later.version > plans.version)
        INTO already_used, superseded FROM study_plan_versions AS plans WHERE plans.id = plan_id FOR UPDATE;
    IF already_used IS NOT NULL THEN RAISE EXCEPTION 'Used study plan is immutable'; END IF;
    IF superseded THEN RAISE EXCEPTION 'Superseded study plan is immutable'; END IF;
    IF TG_OP = 'UPDATE' AND OLD.plan_version_id <> NEW.plan_version_id THEN
        SELECT plans.used_at, EXISTS(SELECT 1 FROM study_plan_versions AS later WHERE later.level_id = plans.level_id AND later.version > plans.version)
            INTO already_used, superseded FROM study_plan_versions AS plans WHERE plans.id = OLD.plan_version_id FOR UPDATE;
        IF already_used IS NOT NULL THEN RAISE EXCEPTION 'Used study plan is immutable'; END IF;
        IF superseded THEN RAISE EXCEPTION 'Superseded study plan is immutable'; END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION protect_used_plan_version() RETURNS trigger AS $$
DECLARE superseded boolean;
BEGIN
    SELECT EXISTS(SELECT 1 FROM study_plan_versions AS later WHERE later.level_id = OLD.level_id AND later.version > OLD.version)
        INTO superseded;
    IF TG_OP = 'DELETE' AND OLD.used_at IS NOT NULL THEN
        RAISE EXCEPTION 'Used study plan is immutable';
    END IF;
    IF TG_OP = 'DELETE' AND superseded THEN
        RAISE EXCEPTION 'Superseded study plan is immutable';
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.level_id <> OLD.level_id OR NEW.version <> OLD.version
        OR (OLD.used_at IS NOT NULL AND (NEW.used_at IS DISTINCT FROM OLD.used_at OR NEW.revision <> OLD.revision))
        OR (superseded AND NEW.revision <> OLD.revision)) THEN
        RAISE EXCEPTION 'Study plan identity and protected content are immutable';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
SQL);
    }

    public function down(): void
    {
        DB::unprepared(<<<'SQL'
CREATE OR REPLACE FUNCTION protect_used_plan_lecture() RETURNS trigger AS $$
DECLARE plan_id uuid;
DECLARE already_used timestamp;
BEGIN
    plan_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.plan_version_id ELSE NEW.plan_version_id END;
    SELECT used_at INTO already_used FROM study_plan_versions WHERE id = plan_id FOR UPDATE;
    IF already_used IS NOT NULL THEN RAISE EXCEPTION 'Used study plan is immutable'; END IF;
    IF TG_OP = 'UPDATE' AND OLD.plan_version_id <> NEW.plan_version_id THEN
        SELECT used_at INTO already_used FROM study_plan_versions WHERE id = OLD.plan_version_id FOR UPDATE;
        IF already_used IS NOT NULL THEN RAISE EXCEPTION 'Used study plan is immutable'; END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION protect_used_plan_version() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' AND OLD.used_at IS NOT NULL THEN RAISE EXCEPTION 'Used study plan is immutable'; END IF;
    IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.level_id <> OLD.level_id OR NEW.version <> OLD.version OR (OLD.used_at IS NOT NULL AND (NEW.used_at IS DISTINCT FROM OLD.used_at OR NEW.revision <> OLD.revision))) THEN
        RAISE EXCEPTION 'Study plan identity and used content are immutable';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
SQL);
    }
};
