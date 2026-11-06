-- Schedule of a site (cronoprogramma): activities with start and end date, progress and
-- finish-to-start dependencies on other activities of the same site, for the Gantt chart.

create table public.site_activities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  site_id uuid not null,
  name text not null check (char_length(name) between 1 and 200),
  start_on date not null,
  end_on date not null,
  progress smallint not null default 0 check (progress between 0 and 100),
  notes text check (char_length(notes) <= 2000),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_on >= start_on),
  unique (company_id, site_id, id),
  foreign key (company_id, site_id) references public.sites (company_id, id) on delete cascade
);
create index site_activities_site_idx on public.site_activities (site_id, start_on, end_on);
create index site_activities_company_idx on public.site_activities (company_id);

-- The composite keys keep both ends of a dependency in the same company and the same site.
create table public.site_activity_dependencies (
  company_id uuid not null,
  site_id uuid not null,
  activity_id uuid not null,
  depends_on_id uuid not null,
  primary key (activity_id, depends_on_id),
  check (activity_id <> depends_on_id),
  foreign key (company_id, site_id, activity_id)
    references public.site_activities (company_id, site_id, id) on delete cascade,
  foreign key (company_id, site_id, depends_on_id)
    references public.site_activities (company_id, site_id, id) on delete cascade
);
create index site_activity_dependencies_depends_idx
  on public.site_activity_dependencies (depends_on_id);
create index site_activity_dependencies_company_idx
  on public.site_activity_dependencies (company_id);

alter table public.site_activities enable row level security;
alter table public.site_activity_dependencies enable row level security;

create policy site_activities_select on public.site_activities
  for select using (company_id = app.current_company_id());
create policy site_activities_insert on public.site_activities
  for insert with check (company_id = app.current_company_id());
create policy site_activities_update on public.site_activities
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy site_activities_delete on public.site_activities
  for delete using (company_id = app.current_company_id());

create policy site_activity_dependencies_select on public.site_activity_dependencies
  for select using (company_id = app.current_company_id());
create policy site_activity_dependencies_insert on public.site_activity_dependencies
  for insert with check (company_id = app.current_company_id());
create policy site_activity_dependencies_delete on public.site_activity_dependencies
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.site_activities to gestionale_app;
grant select, insert, delete on public.site_activity_dependencies to gestionale_app;
