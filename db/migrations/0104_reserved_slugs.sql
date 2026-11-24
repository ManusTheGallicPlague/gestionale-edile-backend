-- More reserved slugs. A company lives at /:azienda/ on the same domain as the frontend's
-- fixed routes, the API and the build's files, so its slug must not take their names:
-- esci (sign-out), conferma-email (the link in the email-change message), api and assets
-- (served by the API and by the build, not by the frontend's router).

do $$
declare
  old_check text;
begin
  select conname into strict old_check
  from pg_constraint
  where conrelid = 'public.companies'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%accedi%';
  execute format('alter table public.companies drop constraint %I', old_check);
end
$$;

alter table public.companies add constraint companies_slug_reserved check (
  slug not in (
    'accedi', 'esci', 'profilo', 'password-dimenticata', 'invito', 'conferma-email',
    'api', 'assets'
  )
);
