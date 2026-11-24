-- Attempts counted per IP where there is no account to count them against: requests for a
-- password reset (always answered 204, whatever the email) and links that do not work
-- (password reset, invitation, email change). Reachable by the auth role only, like the
-- sign-in failures.

create table auth.ip_attempts (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('password_reset_request', 'link_failure')),
  ip text not null,
  attempted_at timestamptz not null default now()
);
create index ip_attempts_ip_idx on auth.ip_attempts (kind, ip, attempted_at);

grant select, insert, delete on auth.ip_attempts to gestionale_auth;
