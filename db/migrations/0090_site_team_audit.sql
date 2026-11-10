-- Change log also for the team of a site: the team has no id of its own, so adding or removing
-- employees is an update of the site with the field "team", one entry per transaction (as the
-- permissions of a role). Nothing is logged when the site is being created or deleted.

create function app.audit_site_team() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  sid uuid := case when tg_op = 'DELETE' then old.site_id else new.site_id end;
  cid uuid;
  actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  entry bigint;
begin
  select company_id into cid from public.sites where id = sid;
  if cid is null then
    return null;
  end if;
  if exists (
    select 1 from public.audit_log
    where entity = 'site' and entity_id = sid and action = 'create' and created_at = now()
  ) then
    return null;
  end if;
  select id into entry from public.audit_log
  where entity = 'site' and entity_id = sid and action = 'update' and created_at = now()
  order by id desc limit 1;
  if entry is null then
    insert into public.audit_log (company_id, entity, entity_id, action, fields, user_id)
    values (cid, 'site', sid, 'update', array['team'], actor);
  else
    update public.audit_log
    set fields = array(select distinct f from unnest(fields || array['team']) f order by f)
    where id = entry;
  end if;
  return null;
end
$$;
revoke all on function app.audit_site_team() from public;

create trigger site_team_audit
  after insert or delete on public.site_team
  for each row execute function app.audit_site_team();
