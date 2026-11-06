-- The team of a site (squadra): which employees work there. Deleting a site removes its
-- team; an employee in a team cannot be deleted (they can be marked as not active).

create table public.site_team (
  company_id uuid not null references public.companies (id) on delete cascade,
  site_id uuid not null,
  employee_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (site_id, employee_id),
  foreign key (company_id, site_id) references public.sites (company_id, id) on delete cascade,
  foreign key (company_id, employee_id) references public.employees (company_id, id)
    on delete restrict
);
create index site_team_employee_idx on public.site_team (employee_id);

alter table public.site_team enable row level security;

create policy site_team_select on public.site_team
  for select using (company_id = app.current_company_id());
create policy site_team_insert on public.site_team
  for insert with check (company_id = app.current_company_id());
create policy site_team_delete on public.site_team
  for delete using (company_id = app.current_company_id());

grant select, insert, delete on public.site_team to gestionale_app;
