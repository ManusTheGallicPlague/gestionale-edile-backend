-- Refuelings of vehicles: one row per fill-up, with the litres (numeric, never float), the cost in
-- cents, the odometer or hour meter and the filling station (a supplier of the company).

create table public.vehicle_refuelings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  vehicle_id uuid not null,
  refueled_on date not null,
  liters numeric(8, 2) not null check (liters > 0),
  amount_cents bigint not null check (amount_cents >= 0),
  meter_reading integer check (meter_reading between 0 and 9999999),
  supplier_id uuid,
  notes text check (char_length(notes) <= 2000),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The refueling belongs to the vehicle: it goes with it.
  foreign key (company_id, vehicle_id) references public.vehicles (company_id, id)
    on delete cascade,
  -- A filling station with refuelings is not deleted (409 has_documents, as for maintenances).
  foreign key (company_id, supplier_id) references public.suppliers (company_id, id)
    on delete restrict
);
create index vehicle_refuelings_vehicle_idx
  on public.vehicle_refuelings (vehicle_id, refueled_on);
create index vehicle_refuelings_supplier_idx on public.vehicle_refuelings (supplier_id)
  where supplier_id is not null;

alter table public.vehicle_refuelings enable row level security;

create policy vehicle_refuelings_select on public.vehicle_refuelings
  for select using (company_id = app.current_company_id());
create policy vehicle_refuelings_insert on public.vehicle_refuelings
  for insert with check (company_id = app.current_company_id());
create policy vehicle_refuelings_update on public.vehicle_refuelings
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy vehicle_refuelings_delete on public.vehicle_refuelings
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.vehicle_refuelings to gestionale_app;
