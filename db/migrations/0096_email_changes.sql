-- Changing one's own email: the new address is confirmed with a one-time token, valid for
-- 24 hours, sent to it by email. Only its SHA-256 is stored. Reachable by the auth role
-- only, like the password resets.

create table auth.email_changes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  new_email text not null
    check (new_email = lower(new_email) and char_length(new_email) between 3 and 254),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index email_changes_user_idx on auth.email_changes (user_id, created_at);

grant select, insert, delete on auth.email_changes to gestionale_auth;
grant update (used_at) on auth.email_changes to gestionale_auth;
grant update (email) on auth.users to gestionale_auth;
