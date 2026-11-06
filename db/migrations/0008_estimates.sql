-- Bills of quantities (computo metrico estimativo): the header. Chapters, items and
-- measurements come next. A client with estimates cannot be deleted.

create table public.estimates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  client_id uuid,
  site_address text check (char_length(site_address) <= 300),
  status text not null default 'draft' check (status in ('draft', 'final')),
  notes text check (char_length(notes) <= 2000),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, client_id) references public.clients (company_id, id)
    on delete restrict
);
create index estimates_company_updated_idx on public.estimates (company_id, updated_at, id);
create index estimates_client_idx on public.estimates (client_id) where client_id is not null;

alter table public.estimates enable row level security;

create policy estimates_select on public.estimates
  for select using (company_id = app.current_company_id());
create policy estimates_insert on public.estimates
  for insert with check (company_id = app.current_company_id());
create policy estimates_update on public.estimates
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy estimates_delete on public.estimates
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.estimates to gestionale_app;
