-- Managing the members of a company: change of role and deactivation. A deactivated
-- member keeps the account (and other companies) but loses access to this company at once:
-- the identity helpers below no longer count the membership.

alter table public.memberships add column disabled_at timestamptz;

create or replace function app.my_company_ids() returns setof uuid
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select company_id from public.memberships
  where user_id = app.current_user_id() and disabled_at is null
$$;

create or replace function app.current_company_id() returns uuid
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select m.company_id
  from public.memberships m
  where m.user_id = app.current_user_id()
    and m.company_id = nullif(current_setting('app.company_id', true), '')::uuid
    and m.disabled_at is null
$$;

-- Each user still sees only their own memberships, and now only the active ones.
drop policy memberships_select on public.memberships;
create policy memberships_select on public.memberships
  for select using (user_id = app.current_user_id() and disabled_at is null);

create or replace function app.company_members()
returns table (
  user_id uuid, name text, email text, active boolean, role_id uuid, role_name text,
  joined_at timestamptz
)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select u.id, u.name, u.email, u.active and m.disabled_at is null, m.role_id, r.name,
    m.created_at
  from public.memberships m
  join auth.users u on u.id = m.user_id
  join public.roles r on r.id = m.role_id
  where m.company_id = app.current_company_id()
$$;

-- Changes a member of the declared company: role (when p_role_id is not null) and/or active
-- state (when p_active is not null). The company row is locked first, so concurrent changes
-- are serialised and the "someone must keep users.manage" check in the API sees them all.
-- Returns false when the user is not a member of the company.
create function app.update_company_member(p_user_id uuid, p_role_id uuid, p_active boolean)
returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  company uuid := app.current_company_id();
begin
  if company is null then
    return false;
  end if;
  perform 1 from public.companies where id = company for update;
  update public.memberships set
    role_id = coalesce(p_role_id, role_id),
    disabled_at = case
      when p_active is null then disabled_at
      when p_active then null
      else coalesce(disabled_at, now())
    end
  where user_id = p_user_id and company_id = company;
  return found;
end
$$;

revoke all on function app.update_company_member(uuid, uuid, boolean) from public;
grant execute on function app.update_company_member(uuid, uuid, boolean) to gestionale_app;

-- An invitation to someone deactivated here is "already a member": they are reactivated
-- instead. is_company_member already counts every membership, active or not.
