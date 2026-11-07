-- /api/me says which of the user's companies have a logo, so the header can show it without
-- a request that ends in 404. The logos' row-level security only opens the declared company,
-- so this function answers for the companies where the current user is an active member,
-- and only whether a logo exists, never the image.

create function app.my_companies_with_logo() returns setof uuid
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select l.company_id
  from public.company_logos l
  join public.memberships m on m.company_id = l.company_id
  where m.user_id = app.current_user_id() and m.disabled_at is null
$$;
revoke all on function app.my_companies_with_logo() from public;
grant execute on function app.my_companies_with_logo() to gestionale_app;
