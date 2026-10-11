-- Rebuild the searchable corpus for sector breadth. Run in the Supabase SQL editor, ONE STEP AT A TIME
-- (select the step's text, then Run), so no single statement hits the editor's time limit.
--
-- Keeps the latest 10-K of 250 companies spread across SIC divisions (all companies in the small
-- divisions, a reproducible md5(cik) sample of the large ones) and deletes every other filing with
-- its text, tree, chunks and vectors. Deleted filings are real SEC documents that can be re-downloaded
-- at no cost. The embedding run refreshes the counters afterwards.

-- STEP 1: choose the 250 filings (a few seconds). Ends by listing the count per sector.
create table if not exists rag.corpus_selection (
  filing_id   uuid primary key references rag.filings (id) on delete cascade,
  division    text not null,
  rule        text not null,
  selected_at timestamptz not null default now()
);
alter table rag.corpus_selection enable row level security;
delete from rag.corpus_selection;
with latest as (
  select distinct on (f.cik) f.cik, f.id from rag.filings f order by f.cik, f.fiscal_year desc, f.filed_at desc),
div as (
  select l.id, l.cik, case
    when c.sic is null then 'Unknown'
    when c.sic::int < 1000 then 'Agriculture' when c.sic::int < 1500 then 'Mining & Energy' when c.sic::int < 1800 then 'Construction'
    when c.sic::int < 4000 then 'Manufacturing' when c.sic::int < 5000 then 'Transport, Comms & Utilities'
    when c.sic::int < 5200 then 'Wholesale' when c.sic::int < 6000 then 'Retail' when c.sic::int < 6800 then 'Finance, Insurance & Real Estate'
    when c.sic::int < 9000 then 'Services' else 'Other' end as division
  from latest l join rag.companies c on c.cik = l.cik),
quota(division, n) as (values ('Manufacturing',95),('Finance, Insurance & Real Estate',45),('Services',35),('Transport, Comms & Utilities',27),
  ('Retail',21),('Mining & Energy',12),('Construction',8),('Wholesale',7),('Agriculture',5),('Other',5),('Unknown',5)),
ranked as (select d.*, row_number() over (partition by d.division order by md5(d.cik)) rn from div d)
insert into rag.corpus_selection (filing_id, division, rule)
select r.id, r.division, 'latest 10-K per company; sector quotas; order md5(cik)'
from ranked r join quota q on q.division = r.division where r.rn <= q.n;
select division, count(*) as filings from rag.corpus_selection group by 1 order by 2 desc;

-- STEP 2: delete up to 150 unselected filings with everything derived from them. Run it repeatedly
-- until it reports "deleted 0" (about four runs).
with gone as (
  delete from rag.filings f
  where f.id in (select f2.id from rag.filings f2
                 where not exists (select 1 from rag.corpus_selection s where s.filing_id = f2.id) limit 150)
  returning 1)
select 'deleted ' || count(*) as result from gone;

-- STEP 3: tidy up (a few seconds).
delete from rag.companies c where not exists (select 1 from rag.filings f where f.cik = c.cik);
update rag.ingest_runs set status = 'aborted', finished_at = coalesce(finished_at, now()) where status = 'running';
select count(*) as filings_left from rag.filings;
