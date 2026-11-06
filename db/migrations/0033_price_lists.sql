-- Price lists of the company (prezzari): e.g. a regional price list of a year, or the
-- company's own prices. Each list has items with code, description, unit and unit price,
-- from which estimate items are taken.

create table public.price_lists (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  year integer check (year between 1900 and 2100),
  notes text check (char_length(notes) <= 2000),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);
create index price_lists_company_idx on public.price_lists (company_id, lower(name), id);

create table public.price_list_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  price_list_id uuid not null,
  code text not null check (char_length(code) between 1 and 50),
  description text not null check (char_length(description) between 1 and 2000),
  unit text not null check (char_length(unit) between 1 and 20),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, price_list_id) references public.price_lists (company_id, id)
    on delete cascade
);
create unique index price_list_items_code_idx on public.price_list_items (price_list_id, lower(code));
create index price_list_items_company_idx on public.price_list_items (company_id);

alter table public.price_lists enable row level security;
alter table public.price_list_items enable row level security;

create policy price_lists_select on public.price_lists
  for select using (company_id = app.current_company_id());
create policy price_lists_insert on public.price_lists
  for insert with check (company_id = app.current_company_id());
create policy price_lists_update on public.price_lists
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy price_lists_delete on public.price_lists
  for delete using (company_id = app.current_company_id());

create policy price_list_items_select on public.price_list_items
  for select using (company_id = app.current_company_id());
create policy price_list_items_insert on public.price_list_items
  for insert with check (company_id = app.current_company_id());
create policy price_list_items_update on public.price_list_items
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy price_list_items_delete on public.price_list_items
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.price_lists to gestionale_app;
grant select, insert, update, delete on public.price_list_items to gestionale_app;
