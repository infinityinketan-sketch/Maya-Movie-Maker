-- Lets the server look up a job at the provider if its result never arrives, and counts busy retries.
alter table public.jobs add column provider_status_url text;
alter table public.jobs add column provider_response_url text;
alter table public.jobs add column attempts integer not null default 0;
