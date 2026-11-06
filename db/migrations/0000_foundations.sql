-- Foundations: schemas and the identity of each request.
--
-- Every company query runs inside a transaction that declares WHO is asking
-- (app.user_id) and FOR WHICH company (app.company_id), with set_config(..., true)
-- so the values die with the transaction and never leak through the pool.
-- Without them the policies match nothing: a forgotten declaration returns zero
-- rows, never someone else's.

create schema if not exists app;
create schema if not exists auth;

revoke all on schema auth from public;
revoke create on schema public from public;

create function app.current_user_id() returns uuid
language sql stable
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;
