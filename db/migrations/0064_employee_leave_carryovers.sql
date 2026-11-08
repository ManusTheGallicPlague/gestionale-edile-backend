-- Vacation days not taken and carried over into a year, as the payslip shows them; negative
-- when the employee took them in advance. One row per employee and year.

create table public.employee_leave_carryovers (
  company_id uuid not null references public.companies (id) on delete cascade,
  employee_id uuid not null,
  year smallint not null check (year between 2000 and 2100),
  days smallint not null check (days between -366 and 366),
  updated_at timestamptz not null default now(),
  primary key (employee_id, year),
  -- The carry-overs belong to the employee: they go with it.
  foreign key (company_id, employee_id) references public.employees (company_id, id)
    on delete cascade
);
create index employee_leave_carryovers_company_idx
  on public.employee_leave_carryovers (company_id, year);

alter table public.employee_leave_carryovers enable row level security;

create policy employee_leave_carryovers_select on public.employee_leave_carryovers
  for select using (company_id = app.current_company_id());
create policy employee_leave_carryovers_insert on public.employee_leave_carryovers
  for insert with check (company_id = app.current_company_id());
create policy employee_leave_carryovers_update on public.employee_leave_carryovers
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy employee_leave_carryovers_delete on public.employee_leave_carryovers
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.employee_leave_carryovers to gestionale_app;
