-- Invitations: the owner invites an email address with a role; the link /invito/:token is
-- valid for 7 days and works once. Only the SHA-256 of the token is stored.

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  email text not null check (email = lower(email) and char_length(email) between 3 and 254),
  role_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  -- Deleting a role takes its pending invitations with it.
  foreign key (company_id, role_id) references public.roles (company_id, id) on delete cascade
);
-- One pending invitation per address and company: a new one replaces the old.
create unique index invitations_pending_key on public.invitations (company_id, email)
  where accepted_at is null;
create index invitations_company_idx on public.invitations (company_id, created_at);

alter table public.invitations enable row level security;

create policy invitations_select on public.invitations
  for select using (company_id = app.current_company_id());
create policy invitations_insert on public.invitations
  for insert with check (company_id = app.current_company_id());
create policy invitations_delete on public.invitations
  for delete using (company_id = app.current_company_id());

-- The token hash is selectable only through the columns listed: the API never sends it back.
grant select (id, company_id, email, role_id, expires_at, accepted_at, created_at),
  insert (company_id, email, role_id, token_hash, expires_at),
  delete
  on public.invitations to gestionale_app;

-- Whether an email is already a member of the declared company (the app role cannot read
-- other users' memberships nor auth.users).
create function app.is_company_member(p_email text) returns boolean
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.memberships m join auth.users u on u.id = m.user_id
    where m.company_id = app.current_company_id() and u.email = lower(p_email)
  )
$$;
revoke all on function app.is_company_member(text) from public;
grant execute on function app.is_company_member(text) to gestionale_app;

-- The invitation behind a token, for the page /invito/:token, before anyone is signed in.
-- Nothing comes back for a token that is unknown, used or expired.
create function auth.invitation_by_token(p_token_hash text)
returns table (
  id uuid, company_name text, email text, role_name text, expires_at timestamptz,
  user_id uuid, user_password_hash text, user_active boolean
)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select i.id, c.name, i.email, r.name, i.expires_at, u.id, u.password_hash, u.active
  from public.invitations i
  join public.companies c on c.id = i.company_id
  join public.roles r on r.id = i.role_id
  left join auth.users u on u.email = i.email
  where i.token_hash = p_token_hash and i.accepted_at is null and i.expires_at > now()
$$;

-- Accepts an invitation in one transaction: locks it, creates the user if there is none
-- (p_password_hash is then required), adds the membership and marks the invitation used.
-- Returns the user id and an outcome: 'ok', 'invalid' (unknown, used, expired, or the
-- account appeared or vanished meanwhile), 'already_member', 'inactive'.
create function auth.accept_invitation(
  p_token_hash text, p_expected_user_id uuid, p_name text, p_password_hash text
)
returns table (outcome text, user_id uuid)
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  inv public.invitations%rowtype;
  usr auth.users%rowtype;
begin
  select * into inv from public.invitations
  where token_hash = p_token_hash and accepted_at is null and expires_at > now()
  for update;
  if not found then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  select * into usr from auth.users where email = inv.email for update;
  if found then
    if p_expected_user_id is distinct from usr.id then
      return query select 'invalid'::text, null::uuid;
      return;
    end if;
    if not usr.active then
      return query select 'inactive'::text, null::uuid;
      return;
    end if;
    if exists (select 1 from public.memberships m
               where m.user_id = usr.id and m.company_id = inv.company_id) then
      return query select 'already_member'::text, null::uuid;
      return;
    end if;
  else
    if p_expected_user_id is not null or p_password_hash is null or p_name is null then
      return query select 'invalid'::text, null::uuid;
      return;
    end if;
    insert into auth.users (email, name, password_hash)
    values (inv.email, p_name, p_password_hash)
    returning * into usr;
  end if;

  insert into public.memberships (user_id, company_id, role_id)
  values (usr.id, inv.company_id, inv.role_id);
  update public.invitations set accepted_at = now(), accepted_user_id = usr.id
  where id = inv.id;
  return query select 'ok'::text, usr.id;
end
$$;

revoke all on function auth.invitation_by_token(text) from public;
revoke all on function auth.accept_invitation(text, uuid, text, text) from public;
grant execute on function auth.invitation_by_token(text) to gestionale_auth;
grant execute on function auth.accept_invitation(text, uuid, text, text) to gestionale_auth;
