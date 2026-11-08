-- Absences of employees: vacation, sick leave, leave (also of a few hours), injury. One row per
-- period, both ends included; the API refuses overlapping periods of the same employee.

create table public.employee_absences (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  employee_id uuid not null,
  kind text not null check (kind in ('vacation', 'sick_leave', 'leave', 'injury', 'other')),
  starts_on date not null,
  ends_on date not null,
  hours numeric(4, 2) check (hours > 0 and hours <= 24),
  notes text check (char_length(notes) <= 2000),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on >= starts_on),
  check (hours is null or ends_on = starts_on),
  check (kind <> 'other' or notes is not null),
  -- The absences belong to the employee: they go with it.
  foreign key (company_id, employee_id) references public.employees (company_id, id)
    on delete cascade
);
create index employee_absences_employee_idx
  on public.employee_absences (employee_id, starts_on);
create index employee_absences_company_idx on public.employee_absences (company_id, starts_on);

alter table public.employee_absences enable row level security;

create policy employee_absences_select on public.employee_absences
  for select using (company_id = app.current_company_id());
create policy employee_absences_insert on public.employee_absences
  for insert with check (company_id = app.current_company_id());
create policy employee_absences_update on public.employee_absences
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy employee_absences_delete on public.employee_absences
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.employee_absences to gestionale_app;
