-- Suppliers and subcontractors. Same rules as clients: company_id, RLS, archive instead of
-- loss, deletion only while no document references them ("on delete restrict").

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  vat_number text check (char_length(vat_number) <= 20),
  tax_code text check (char_length(tax_code) <= 16),
  email text check (char_length(email) <= 254),
  pec text check (char_length(pec) <= 254),
  phone text check (char_length(phone) <= 30),
  street text check (char_length(street) <= 200),
  postal_code text check (char_length(postal_code) <= 10),
  city text check (char_length(city) <= 100),
  province text check (char_length(province) <= 2),
  country text not null default 'IT' check (country ~ '^[A-Z]{2}$'),
  categories text[] not null default '{}'
    check (categories <@ array['materials', 'rentals', 'subcontracting', 'services', 'other']),
  subcontractor boolean not null default false,
  notes text check (char_length(notes) <= 2000),
  archived_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index suppliers_vat_number_key on public.suppliers (company_id, vat_number)
  where vat_number is not null;
create unique index suppliers_tax_code_key on public.suppliers (company_id, tax_code)
  where tax_code is not null;
create index suppliers_company_name_idx on public.suppliers (company_id, lower(name), id);
create index suppliers_company_created_idx on public.suppliers (company_id, created_at, id);

alter table public.suppliers enable row level security;

create policy suppliers_select on public.suppliers
  for select using (company_id = app.current_company_id());
create policy suppliers_insert on public.suppliers
  for insert with check (company_id = app.current_company_id());
create policy suppliers_update on public.suppliers
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy suppliers_delete on public.suppliers
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.suppliers to gestionale_app;
