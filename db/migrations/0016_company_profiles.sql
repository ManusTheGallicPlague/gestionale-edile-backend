-- Company profile: the legal and tax data printed on documents (quotes now, invoices later).
-- At most one row per company; until it is saved the API answers with the company name and
-- empty fields (version 0), so a new company needs no row.

create table public.company_profiles (
  company_id uuid primary key references public.companies (id) on delete cascade,
  legal_name text not null check (char_length(legal_name) between 1 and 200),
  vat_number text check (char_length(vat_number) <= 20),
  tax_code text check (char_length(tax_code) <= 16),
  rea text check (char_length(rea) <= 30),
  share_capital_cents bigint check (share_capital_cents >= 0),
  street text check (char_length(street) <= 200),
  postal_code text check (char_length(postal_code) <= 10),
  city text check (char_length(city) <= 100),
  province text check (char_length(province) <= 2),
  country text not null default 'IT' check (country ~ '^[A-Z]{2}$'),
  phone text check (char_length(phone) <= 30),
  email text check (char_length(email) <= 254),
  pec text check (char_length(pec) <= 254),
  iban text check (iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'),
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.company_profiles enable row level security;

create policy company_profiles_select on public.company_profiles
  for select using (company_id = app.current_company_id());
create policy company_profiles_insert on public.company_profiles
  for insert with check (company_id = app.current_company_id());
create policy company_profiles_update on public.company_profiles
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());

grant select, insert, update on public.company_profiles to gestionale_app;
