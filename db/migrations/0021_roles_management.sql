-- Roles and their permissions become editable by the API, always inside the declared
-- company. A role still used by a membership cannot be deleted (the composite key on
-- memberships refuses it); its pending invitations go with it.

create policy roles_insert on public.roles
  for insert with check (company_id = app.current_company_id());
create policy roles_update on public.roles
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy roles_delete on public.roles
  for delete using (company_id = app.current_company_id());

create policy role_permissions_insert on public.role_permissions
  for insert with check (
    role_id in (select id from public.roles where company_id = app.current_company_id())
  );
create policy role_permissions_delete on public.role_permissions
  for delete using (
    role_id in (select id from public.roles where company_id = app.current_company_id())
  );

grant insert (company_id, name), update (name), delete on public.roles to gestionale_app;
grant insert, delete on public.role_permissions to gestionale_app;

-- Locks the declared company's row until commit: changes to members and roles take it
-- first, so the check that someone can still manage users and roles sees them all.
create function app.lock_company() returns void
language sql volatile security definer
set search_path = pg_catalog, public
as $$
  select null from public.companies where id = app.current_company_id() for update
$$;
revoke all on function app.lock_company() from public;
grant execute on function app.lock_company() to gestionale_app;
