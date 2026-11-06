-- Progress statements (SAL, stati di avanzamento lavori) of an estimate: numbered in order,
-- draft until approved. Each line is the quantity of an estimate item executed in that
-- statement, with the unit price copied from the item, so an approved statement does not
-- change when the estimate does.

create table public.progress_statements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  estimate_id uuid not null,
  number integer not null check (number >= 1),
  statement_date date not null,
  notes text check (char_length(notes) <= 2000),
  status text not null default 'draft' check (status in ('draft', 'approved')),
  approved_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'approved') = (approved_at is not null)),
  unique (estimate_id, number),
  unique (company_id, estimate_id, id),
  foreign key (company_id, estimate_id) references public.estimates (company_id, id)
    on delete cascade
);
-- At most one draft per estimate.
create unique index progress_statements_one_draft_idx
  on public.progress_statements (estimate_id) where status = 'draft';
create index progress_statements_company_idx on public.progress_statements (company_id);

create table public.progress_statement_lines (
  company_id uuid not null,
  estimate_id uuid not null,
  statement_id uuid not null,
  item_id uuid not null,
  quantity numeric(14, 3) not null,
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  primary key (statement_id, item_id),
  foreign key (company_id, estimate_id, statement_id)
    references public.progress_statements (company_id, estimate_id, id) on delete cascade,
  foreign key (company_id, estimate_id, item_id)
    references public.estimate_items (company_id, estimate_id, id) on delete cascade
);
create index progress_statement_lines_item_idx on public.progress_statement_lines (item_id);
create index progress_statement_lines_fk_idx
  on public.progress_statement_lines (company_id, estimate_id, item_id);

alter table public.progress_statements enable row level security;
alter table public.progress_statement_lines enable row level security;

create policy progress_statements_select on public.progress_statements
  for select using (company_id = app.current_company_id());
create policy progress_statements_insert on public.progress_statements
  for insert with check (company_id = app.current_company_id());
create policy progress_statements_update on public.progress_statements
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy progress_statements_delete on public.progress_statements
  for delete using (company_id = app.current_company_id());

create policy progress_statement_lines_select on public.progress_statement_lines
  for select using (company_id = app.current_company_id());
create policy progress_statement_lines_insert on public.progress_statement_lines
  for insert with check (company_id = app.current_company_id());
create policy progress_statement_lines_delete on public.progress_statement_lines
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.progress_statements to gestionale_app;
grant select, insert, delete on public.progress_statement_lines to gestionale_app;
