-- Company logo, printed on documents and shown in the interface. One per company, PNG or
-- JPEG, at most 512 KB (checked by the API, and here as a last line of defence).

create table public.company_logos (
  company_id uuid primary key references public.companies (id) on delete cascade,
  content_type text not null check (content_type in ('image/png', 'image/jpeg')),
  data bytea not null check (octet_length(data) between 1 and 524288),
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.company_logos enable row level security;

create policy company_logos_select on public.company_logos
  for select using (company_id = app.current_company_id());
create policy company_logos_insert on public.company_logos
  for insert with check (company_id = app.current_company_id());
create policy company_logos_update on public.company_logos
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy company_logos_delete on public.company_logos
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.company_logos to gestionale_app;
