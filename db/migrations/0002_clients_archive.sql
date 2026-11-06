-- Clients: archiving and deletion.
--
-- A client is archived, never lost: archived_at hides it from the default list.
-- Deletion is allowed only while nothing points to the client: tables that link to
-- clients (quotes, estimates, deadlines) must reference it with "on delete restrict",
-- so the database itself refuses to delete a client with documents.

alter table public.clients add column archived_at timestamptz;

create index clients_company_archived_idx on public.clients (company_id, (archived_at is null));

create policy clients_delete on public.clients
  for delete using (company_id = app.current_company_id());

grant delete on public.clients to gestionale_app;
