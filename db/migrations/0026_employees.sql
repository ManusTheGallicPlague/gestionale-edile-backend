-- Employees (dipendenti): the people who work on the sites. Daily reports and the site
-- team will point here; the hourly cost feeds the labour costs.

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  first_name text not null check (char_length(first_name) between 1 and 100),
  last_name text not null check (char_length(last_name) between 1 and 100),
  tax_code text check (tax_code ~ '^[A-Z0-9]{16}$'),
  job_title text check (char_length(job_title) <= 100),
  phone text check (char_length(phone) <= 30),
  email text check (char_length(email) <= 254),
  hired_on date,
  hourly_cost_cents bigint check (hourly_cost_cents >= 0),
  active boolean not null default true,
  notes text check (char_length(notes) <= 2000),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);
create unique index employees_company_tax_code_idx on public.employees (company_id, tax_code)
  where tax_code is not null;
create index employees_company_name_idx on public.employees
  (company_id, lower(last_name), lower(first_name), id);

alter table public.employees enable row level security;

create policy employees_select on public.employees
  for select using (company_id = app.current_company_id());
create policy employees_insert on public.employees
  for insert with check (company_id = app.current_company_id());
create policy employees_update on public.employees
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy employees_delete on public.employees
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.employees to gestionale_app;

alter table public.audit_log drop constraint audit_log_entity_check;
alter table public.audit_log add constraint audit_log_entity_check
  check (entity in ('client', 'supplier', 'deadline', 'estimate', 'quote', 'site', 'employee'));

create trigger employees_audit after insert or update or delete on public.employees
  for each row execute function app.audit_row('employee');
