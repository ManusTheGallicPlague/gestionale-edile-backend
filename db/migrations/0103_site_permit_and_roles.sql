-- Building permit and the people of the site, as on the site sign: permit (type, number and
-- date in one line), works director, safety coordinator for the execution phase, and the day
-- the prior notice (notifica preliminare) was sent. All optional. The table already has RLS
-- and the grants for gestionale_app; the new columns follow them.

alter table public.sites add column permit text;
alter table public.sites add column works_director text;
alter table public.sites add column safety_coordinator text;
alter table public.sites add column prior_notice_on date;
alter table public.sites add constraint sites_permit_check check (char_length(permit) <= 200);
alter table public.sites add constraint sites_works_director_check
  check (char_length(works_director) <= 200);
alter table public.sites add constraint sites_safety_coordinator_check
  check (char_length(safety_coordinator) <= 200);
