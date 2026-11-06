-- Measurement rows (righe di misura) of an estimate item. The quantity is the product of
-- the factors that are present, rounded to 3 decimals, computed by the database. Factors
-- can be negative (deductions). At least one factor is required.

create table public.estimate_measurements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  estimate_id uuid not null,
  item_id uuid not null,
  description text check (char_length(description) <= 500),
  equal_parts numeric(12,3),
  length numeric(12,3),
  width numeric(12,3),
  height numeric(12,3),
  quantity numeric(14,3) generated always as (
    round(coalesce(equal_parts, 1) * coalesce(length, 1) * coalesce(width, 1)
      * coalesce(height, 1), 3)
  ) stored,
  position integer not null check (position >= 0),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (num_nonnulls(equal_parts, length, width, height) > 0),
  foreign key (company_id, estimate_id, item_id)
    references public.estimate_items (company_id, estimate_id, id) on delete cascade
);
create index estimate_measurements_item_idx
  on public.estimate_measurements (estimate_id, item_id, position);
create index estimate_measurements_fk_idx
  on public.estimate_measurements (company_id, estimate_id, item_id);

alter table public.estimate_measurements enable row level security;

create policy estimate_measurements_select on public.estimate_measurements
  for select using (company_id = app.current_company_id());
create policy estimate_measurements_insert on public.estimate_measurements
  for insert with check (company_id = app.current_company_id());
create policy estimate_measurements_update on public.estimate_measurements
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy estimate_measurements_delete on public.estimate_measurements
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.estimate_measurements to gestionale_app;
