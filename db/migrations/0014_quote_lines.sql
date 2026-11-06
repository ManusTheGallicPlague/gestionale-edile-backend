-- Quote lines: priced items, text-only lines and section headings, in order. Only item
-- lines carry unit, quantity, price, discount and VAT rate. The line amount (taxable, in
-- cents) is computed when read: quantity × price × (1 − discount), rounded to the cent.

create table public.quote_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  quote_id uuid not null,
  kind text not null check (kind in ('item', 'text', 'section')),
  description text not null check (char_length(description) between 1 and 5000),
  unit text check (char_length(unit) between 1 and 20),
  quantity numeric(14,3),
  unit_price_cents bigint check (unit_price_cents >= 0),
  discount_percent numeric(5,2) check (discount_percent between 0 and 100),
  vat_rate smallint check (vat_rate in (0, 4, 5, 10, 22)),
  position integer not null check (position >= 0),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (kind = 'item') = (quantity is not null and unit_price_cents is not null
      and discount_percent is not null and vat_rate is not null)
  ),
  check (kind = 'item' or unit is null),
  foreign key (company_id, quote_id) references public.quotes (company_id, id)
    on delete cascade
);
create index quote_lines_quote_idx on public.quote_lines (quote_id, position);
create index quote_lines_fk_idx on public.quote_lines (company_id, quote_id);

alter table public.quote_lines enable row level security;

create policy quote_lines_select on public.quote_lines
  for select using (company_id = app.current_company_id());
create policy quote_lines_insert on public.quote_lines
  for insert with check (company_id = app.current_company_id());
create policy quote_lines_update on public.quote_lines
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy quote_lines_delete on public.quote_lines
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.quote_lines to gestionale_app;
