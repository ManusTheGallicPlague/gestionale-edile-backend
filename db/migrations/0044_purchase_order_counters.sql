-- Starting point of the purchase order numbering, per company and year, set in the settings.
-- A new order takes one more than the highest of this floor and the numbers already used,
-- so the floor only matters for whoever moves here from another program in the middle of a year.

create table public.purchase_order_counters (
  company_id uuid not null references public.companies (id) on delete cascade,
  year integer not null check (year between 2000 and 2999),
  last_number integer not null check (last_number >= 0),
  primary key (company_id, year)
);

alter table public.purchase_order_counters enable row level security;

create policy purchase_order_counters_select on public.purchase_order_counters
  for select using (company_id = app.current_company_id());
create policy purchase_order_counters_insert on public.purchase_order_counters
  for insert with check (company_id = app.current_company_id());
create policy purchase_order_counters_update on public.purchase_order_counters
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());

grant select, insert, update on public.purchase_order_counters to gestionale_app;
