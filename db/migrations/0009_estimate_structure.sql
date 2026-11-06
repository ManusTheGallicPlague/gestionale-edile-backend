-- Bills of quantities: the tree. Chapters can be nested; items (voci) always sit in a
-- chapter. Everything belongs to one estimate of one company, enforced by composite
-- foreign keys, so a parent or chapter of another estimate (or company) cannot be used.
-- Deleting an estimate or a chapter removes what is inside it.

create table public.estimate_chapters (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  estimate_id uuid not null,
  parent_id uuid,
  code text check (char_length(code) <= 50),
  title text not null check (char_length(title) between 1 and 200),
  position integer not null check (position >= 0),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, estimate_id, id),
  foreign key (company_id, estimate_id) references public.estimates (company_id, id)
    on delete cascade,
  foreign key (company_id, estimate_id, parent_id)
    references public.estimate_chapters (company_id, estimate_id, id) on delete cascade
);
create index estimate_chapters_estimate_idx
  on public.estimate_chapters (estimate_id, parent_id, position);
create index estimate_chapters_parent_idx
  on public.estimate_chapters (company_id, estimate_id, parent_id);

create table public.estimate_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  estimate_id uuid not null,
  chapter_id uuid not null,
  code text check (char_length(code) <= 50),
  description text not null check (char_length(description) between 1 and 5000),
  unit text not null check (char_length(unit) between 1 and 20),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  position integer not null check (position >= 0),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, estimate_id, id),
  foreign key (company_id, estimate_id, chapter_id)
    references public.estimate_chapters (company_id, estimate_id, id) on delete cascade
);
create index estimate_items_chapter_idx
  on public.estimate_items (estimate_id, chapter_id, position);
create index estimate_items_fk_idx on public.estimate_items (company_id, estimate_id, chapter_id);

alter table public.estimate_chapters enable row level security;
alter table public.estimate_items enable row level security;

create policy estimate_chapters_select on public.estimate_chapters
  for select using (company_id = app.current_company_id());
create policy estimate_chapters_insert on public.estimate_chapters
  for insert with check (company_id = app.current_company_id());
create policy estimate_chapters_update on public.estimate_chapters
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy estimate_chapters_delete on public.estimate_chapters
  for delete using (company_id = app.current_company_id());

create policy estimate_items_select on public.estimate_items
  for select using (company_id = app.current_company_id());
create policy estimate_items_insert on public.estimate_items
  for insert with check (company_id = app.current_company_id());
create policy estimate_items_update on public.estimate_items
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy estimate_items_delete on public.estimate_items
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.estimate_chapters to gestionale_app;
grant select, insert, update, delete on public.estimate_items to gestionale_app;
