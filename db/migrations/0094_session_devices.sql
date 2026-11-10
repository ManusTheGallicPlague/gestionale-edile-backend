-- Open sessions of a user, listed in the profile so that one can be closed from another
-- device. The id of a session is the SHA-256 of its cookie token and binds the CSRF token:
-- it never leaves the server, so each session gets a public id of its own. The browser
-- (User-Agent, cut to 300 characters) and the last request, written at most every five
-- minutes, tell the sessions apart. Sessions opened before this migration have neither.

alter table auth.sessions
  add column public_id uuid not null default gen_random_uuid(),
  add column user_agent text check (char_length(user_agent) <= 300),
  add column last_used_at timestamptz not null default now();

create unique index sessions_public_id_idx on auth.sessions (public_id);
