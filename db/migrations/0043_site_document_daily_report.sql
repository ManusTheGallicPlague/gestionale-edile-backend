-- A document or photo of a site may belong to one daily report of the same site (photos
-- taken on site while filling in the report). Deleting the report keeps the file in the
-- site archive, only the link goes; moving a draft report to another site moves its files.

alter table public.daily_reports
  add constraint daily_reports_company_site_id_key unique (company_id, site_id, id);

alter table public.site_documents add column daily_report_id uuid;
alter table public.site_documents add constraint site_documents_daily_report_fkey
  foreign key (company_id, site_id, daily_report_id)
  references public.daily_reports (company_id, site_id, id)
  on update cascade on delete set null (daily_report_id);
create index site_documents_daily_report_idx on public.site_documents (daily_report_id)
  where daily_report_id is not null;
