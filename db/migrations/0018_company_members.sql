-- Members of the declared company, with name, email and role, for the users page. The app
-- role cannot read auth.users (password hashes) nor other users' memberships: this function
-- returns only these columns, and only for the company that app.current_company_id() has
-- already checked the user belongs to.

create function app.company_members()
returns table (
  user_id uuid, name text, email text, active boolean, role_id uuid, role_name text,
  joined_at timestamptz
)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select u.id, u.name, u.email, u.active, m.role_id, r.name, m.created_at
  from public.memberships m
  join auth.users u on u.id = m.user_id
  join public.roles r on r.id = m.role_id
  where m.company_id = app.current_company_id()
$$;

revoke all on function app.company_members() from public;
grant execute on function app.company_members() to gestionale_app;
