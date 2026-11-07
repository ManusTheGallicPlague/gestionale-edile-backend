-- The page /invito/:token shows the logo of the inviting company, before anyone is signed
-- in. Only a valid invitation (known, unused, not expired) opens it, as for
-- auth.invitation_by_token; the logo table keeps its row-level security for everything else.

create function auth.invitation_logo(p_token_hash text)
returns table (content_type text, data bytea, version integer)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select l.content_type, l.data, l.version
  from public.invitations i
  join public.company_logos l on l.company_id = i.company_id
  where i.token_hash = p_token_hash and i.accepted_at is null and i.expires_at > now()
$$;

create function auth.invitation_has_logo(p_token_hash text)
returns boolean
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.invitations i
    join public.company_logos l on l.company_id = i.company_id
    where i.token_hash = p_token_hash and i.accepted_at is null and i.expires_at > now()
  )
$$;

revoke all on function auth.invitation_logo(text) from public;
revoke all on function auth.invitation_has_logo(text) from public;
grant execute on function auth.invitation_logo(text) to gestionale_auth;
grant execute on function auth.invitation_has_logo(text) to gestionale_auth;
