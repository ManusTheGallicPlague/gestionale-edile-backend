-- Forgotten password: a one-time token, valid for an hour, sent by email. Only its SHA-256
-- is stored. Reachable by the auth role only, like the sessions.

create table auth.password_resets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index password_resets_user_idx on auth.password_resets (user_id, created_at);

grant select, insert, delete on auth.password_resets to gestionale_auth;
grant update (used_at) on auth.password_resets to gestionale_auth;
