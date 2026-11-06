-- ============================================================
-- AUTH: reachable only by gestionale_auth, never by the API role.
-- ============================================================

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email) and char_length(email) between 3 and 254),
  name text not null check (char_length(name) between 1 and 200),
  password_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- The cookie holds a random token; only its SHA-256 is stored here.
create table auth.sessions (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index sessions_user_idx on auth.sessions (user_id);

create table auth.login_failures (
  id bigint generated always as identity primary key,
  email text not null,
  ip text not null,
  failed_at timestamptz not null default now()
);
create index login_failures_email_idx on auth.login_failures (email, failed_at);
create index login_failures_ip_idx on auth.login_failures (ip, failed_at);

-- ============================================================
-- COMPANIES, ROLES, MEMBERSHIPS
-- ============================================================

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  -- Never changes after creation: saved links would break.
  slug text not null unique
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 50)
    -- The frontend's fixed routes live next to /:azienda/
    check (slug not in ('accedi', 'profilo', 'password-dimenticata', 'invito', 'api')),
  name text not null check (char_length(name) between 1 and 200),
  created_at timestamptz not null default now()
);

-- Roles are per company, so each company can shape its own.
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  unique (company_id, name),
  -- Lets memberships check that role and company match.
  unique (company_id, id)
);

-- The permission catalog lives in the code (src/permissions.ts).
create table public.role_permissions (
  role_id uuid not null references public.roles (id) on delete cascade,
  permission text not null check (permission ~ '^[a-z_]+\.[a-z_]+$'),
  primary key (role_id, permission)
);

create table public.memberships (
  user_id uuid not null references auth.users (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  role_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, company_id),
  -- A membership can only use a role of its own company.
  foreign key (company_id, role_id) references public.roles (company_id, id)
);
create index memberships_company_idx on public.memberships (company_id);

-- ============================================================
-- CLIENTS
-- ============================================================

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  kind text not null check (kind in ('company', 'person', 'public_body')),
  name text not null check (char_length(name) between 1 and 200),
  vat_number text check (char_length(vat_number) <= 20),
  tax_code text check (char_length(tax_code) <= 16),
  email text check (char_length(email) <= 254),
  pec text check (char_length(pec) <= 254),
  phone text check (char_length(phone) <= 30),
  sdi_code text check (char_length(sdi_code) between 6 and 7),
  street text check (char_length(street) <= 200),
  postal_code text check (char_length(postal_code) <= 10),
  city text check (char_length(city) <= 100),
  province text check (char_length(province) = 2),
  country text not null default 'IT' check (country ~ '^[A-Z]{2}$'),
  notes text check (char_length(notes) <= 2000),
  -- Bumped on every update: it is the ETag that guards against lost updates.
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index clients_vat_number_key on public.clients (company_id, vat_number)
  where vat_number is not null;
create unique index clients_tax_code_key on public.clients (company_id, kind, tax_code)
  where tax_code is not null;
create index clients_company_name_idx on public.clients (company_id, lower(name), id);
create index clients_company_created_idx on public.clients (company_id, created_at, id);

-- ============================================================
-- IDENTITY HELPERS
-- Security definer, so the policies can read memberships without recursion.
-- ============================================================

create function app.my_company_ids() returns setof uuid
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select company_id from public.memberships where user_id = app.current_user_id()
$$;

-- The declared company counts only if the declared user belongs to it.
create function app.current_company_id() returns uuid
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select m.company_id
  from public.memberships m
  where m.user_id = app.current_user_id()
    and m.company_id = nullif(current_setting('app.company_id', true), '')::uuid
$$;

revoke all on function app.my_company_ids() from public;
revoke all on function app.current_company_id() from public;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.companies enable row level security;
alter table public.roles enable row level security;
alter table public.role_permissions enable row level security;
alter table public.memberships enable row level security;
alter table public.clients enable row level security;

create policy companies_select on public.companies
  for select using (id in (select app.my_company_ids()));

create policy roles_select on public.roles
  for select using (company_id in (select app.my_company_ids()));

create policy role_permissions_select on public.role_permissions
  for select using (role_id in (select id from public.roles));

create policy memberships_select on public.memberships
  for select using (user_id = app.current_user_id());

-- Clients belong to the company in the URL, and only if the user is a member.
create policy clients_select on public.clients
  for select using (company_id = app.current_company_id());
create policy clients_insert on public.clients
  for insert with check (company_id = app.current_company_id());
create policy clients_update on public.clients
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());

-- ============================================================
-- PRIVILEGES (roles are created by scripts/migrate.ts)
-- ============================================================

grant usage on schema app to gestionale_app;
grant execute on function app.current_user_id() to gestionale_app;
grant execute on function app.my_company_ids() to gestionale_app;
grant execute on function app.current_company_id() to gestionale_app;

grant usage on schema public to gestionale_app;
grant select on public.companies, public.roles, public.role_permissions, public.memberships
  to gestionale_app;
grant select, insert, update on public.clients to gestionale_app;

grant usage on schema auth to gestionale_auth;
grant select on auth.users to gestionale_auth;
grant select, insert, update, delete on auth.sessions to gestionale_auth;
grant select, insert, delete on auth.login_failures to gestionale_auth;
