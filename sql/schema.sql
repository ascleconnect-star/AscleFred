-- ══════════════════════════════════════════════════════════════════
--  ASCLE — TELECONSULTATION SCHEMA
--  Run this in Supabase Dashboard → SQL Editor (or via `supabase db push`)
--
--  Notes on fit with the existing Ascle app:
--  - Your app's signup flow already writes to a `profiles` table with
--    role ∈ {'patient','doctor','nurse','admin'} (see su-role field /
--    the sb.from('profiles').upsert(...) call in index-6.html).
--  - The brief asks for two user types, 'patient' and 'practitioner'.
--    Rather than fork the schema, "practitioner" is treated as a
--    *category*, not a literal role value: practitioner_id on
--    `consultations` must point at a profile whose role is 'doctor'
--    or 'nurse'. This keeps one profiles table for the whole app.
--  - If `profiles` already exists in your project, the CREATE TABLE
--    below is written IF NOT EXISTS / additive so it's safe to run
--    again — it will not drop or overwrite existing patient data.
-- ══════════════════════════════════════════════════════════════════

-- Needed for gen_random_uuid()
create extension if not exists pgcrypto;

-- ──────────────────────────────────────────────────────────────────
-- 1. PROFILES
-- ──────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  full_name       text not null default '',
  email           text,
  phone           text,
  role            text not null default 'patient'
                    check (role in ('patient','doctor','nurse','admin')),
  licence_number  text,           -- practitioners only (MDCN etc.)
  specialty       text,           -- practitioners only
  city            text,
  address         text,
  dob             date,
  verified        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on column public.profiles.role is
  'patient | doctor | nurse | admin. "practitioner" (as referenced by the '
  'teleconsult feature) means role IN (doctor, nurse).';

alter table public.profiles enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles for select
  using (auth.uid() = id);

-- Lets a patient/practitioner see the *name* of the other party on a
-- shared consultation (needed for "Dr. Adaeze Obi" to render in the
-- UI) without exposing every column of every profile to every user.
drop policy if exists profiles_select_consultation_partner on public.profiles;
create policy profiles_select_consultation_partner
  on public.profiles for select
  using (
    exists (
      select 1 from public.consultations c
      where (c.patient_id = auth.uid() and c.practitioner_id = profiles.id)
         or (c.practitioner_id = auth.uid() and c.patient_id = profiles.id)
    )
  );

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own
  on public.profiles for insert
  with check (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

create index if not exists idx_profiles_role on public.profiles(role);

-- ──────────────────────────────────────────────────────────────────
-- 2. CONSULTATIONS
-- ──────────────────────────────────────────────────────────────────
create table if not exists public.consultations (
  id               uuid primary key default gen_random_uuid(),
  patient_id       uuid not null references public.profiles(id) on delete cascade,
  practitioner_id  uuid references public.profiles(id) on delete set null,
  status           text not null default 'scheduled'
                     check (status in ('scheduled','active','completed','cancelled')),
  scheduled_at     timestamptz not null default now(),
  daily_room_url   text,          -- set ONLY by the server (Netlify fn), never by a client
  daily_room_name  text,          -- Daily room name, used to reuse/expire the room
  ended_at         timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_consultations_patient      on public.consultations(patient_id);
create index if not exists idx_consultations_practitioner on public.consultations(practitioner_id);
create index if not exists idx_consultations_status       on public.consultations(status);

alter table public.consultations enable row level security;

-- ── SELECT: only the two participants can see a consultation ──────
drop policy if exists consultations_select_participants on public.consultations;
create policy consultations_select_participants
  on public.consultations for select
  using (auth.uid() = patient_id or auth.uid() = practitioner_id);

-- ── INSERT: a patient books a consultation for themselves ─────────
drop policy if exists consultations_insert_patient on public.consultations;
create policy consultations_insert_patient
  on public.consultations for insert
  with check (auth.uid() = patient_id);

-- ── UPDATE: patients may only cancel their own *scheduled* booking ─
drop policy if exists consultations_update_patient_cancel on public.consultations;
create policy consultations_update_patient_cancel
  on public.consultations for update
  using (auth.uid() = patient_id and status = 'scheduled')
  with check (auth.uid() = patient_id and status in ('scheduled','cancelled'));

-- ── UPDATE: practitioners may move their own consultation forward
--    through the call lifecycle (start it, end it) ──────────────────
drop policy if exists consultations_update_practitioner on public.consultations;
create policy consultations_update_practitioner
  on public.consultations for update
  using (auth.uid() = practitioner_id)
  with check (
    auth.uid() = practitioner_id
    and status in ('scheduled','active','completed','cancelled')
  );

-- No DELETE policy is defined on purpose: consultations are never
-- hard-deleted by end users, only cancelled. Only the service_role
-- key (which bypasses RLS entirely) can delete rows, e.g. from an
-- admin tool.

-- ── Column guard: daily_room_url / daily_room_name can only be
--    written by the server (service_role key), never by a patient
--    or practitioner directly through the client SDK, even though
--    the UPDATE policies above technically permit updating the row.
-- ──────────────────────────────────────────────────────────────────
create or replace function public.protect_daily_room_columns()
returns trigger
language plpgsql
security definer
as $$
begin
  if auth.role() <> 'service_role' then
    if new.daily_room_url is distinct from old.daily_room_url
       or new.daily_room_name is distinct from old.daily_room_name then
      raise exception 'daily_room_url / daily_room_name can only be set by the server';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_protect_daily_room_columns on public.consultations;
create trigger trg_protect_daily_room_columns
  before update on public.consultations
  for each row execute function public.protect_daily_room_columns();

-- ── Insert guard: enforce patient/practitioner roles + no self-consult
-- ──────────────────────────────────────────────────────────────────
create or replace function public.validate_consultation_parties()
returns trigger
language plpgsql
security definer
as $$
declare
  patient_role text;
  practitioner_role text;
begin
  select role into patient_role from public.profiles where id = new.patient_id;
  if patient_role is distinct from 'patient' then
    raise exception 'patient_id must reference a profile with role = patient';
  end if;

  if new.practitioner_id is not null then
    select role into practitioner_role from public.profiles where id = new.practitioner_id;
    if practitioner_role not in ('doctor','nurse') then
      raise exception 'practitioner_id must reference a profile with role doctor or nurse';
    end if;
    if new.practitioner_id = new.patient_id then
      raise exception 'practitioner_id and patient_id cannot be the same profile';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_consultation_parties on public.consultations;
create trigger trg_validate_consultation_parties
  before insert or update on public.consultations
  for each row execute function public.validate_consultation_parties();

-- ══════════════════════════════════════════════════════════════════
-- Done. Verify with:
--   select * from pg_policies where tablename in ('profiles','consultations');
-- ══════════════════════════════════════════════════════════════════
