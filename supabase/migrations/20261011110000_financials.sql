-- Reported financial figures for Compare & rank.
--
-- Passage search finds text about a topic; it cannot rank companies ("who has the best margin?"),
-- because no single passage contains the answer. These are the figures each company reported in its
-- 10-K's XBRL data (SEC "company facts"), one row per company, metric and annual period, so ranking
-- is a query rather than a guess. Margins are computed at query time from the reported numbers.

create table if not exists rag.financial_facts (
  cik          text    not null references rag.companies (cik) on delete cascade,
  metric       text    not null check (metric in ('revenue', 'gross_profit', 'cost_of_revenue',
                                                    'operating_income', 'net_income')),
  period_end   date    not null,
  period_start date    not null,
  value        numeric not null,
  xbrl_tag     text    not null,
  accession_no text    not null,
  form         text    not null,
  filed        date    not null,
  loaded_at    timestamptz not null default now(),
  primary key (cik, metric, period_end)
);
create index if not exists financial_facts_end_idx on rag.financial_facts (period_end);
alter table rag.financial_facts enable row level security;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'rag_loader') then
    execute 'grant select, insert, update, delete on rag.financial_facts to rag_loader';
    execute 'drop policy if exists rag_loader_all on rag.financial_facts';
    execute 'create policy rag_loader_all on rag.financial_facts for all to rag_loader using (true) with check (true)';
  end if;
end $$;

-- SIC code -> broad sector (SEC SIC divisions).
create or replace function rag.sic_division(p_sic text) returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_sic is null or p_sic !~ '^\d+$' then 'Unknown'
    when p_sic::int < 1000 then 'Agriculture'
    when p_sic::int < 1500 then 'Mining & Energy'
    when p_sic::int < 1800 then 'Construction'
    when p_sic::int < 4000 then 'Manufacturing'
    when p_sic::int < 5000 then 'Transport, Comms & Utilities'
    when p_sic::int < 5200 then 'Wholesale'
    when p_sic::int < 6000 then 'Retail'
    when p_sic::int < 6800 then 'Finance, Insurance & Real Estate'
    when p_sic::int < 9000 then 'Services'
    else 'Other'
  end;
$$;

-- One row per company and fiscal year (labelled by the calendar year its fiscal year ends in).
create or replace view rag.financial_years as
with f as (
  select cik, extract(year from period_end)::int as fiscal_year, period_end, metric, value, accession_no, filed
  from rag.financial_facts
),
p as (
  select cik, fiscal_year,
         max(period_end) as period_end,
         max(value) filter (where metric = 'revenue')          as revenue,
         max(value) filter (where metric = 'gross_profit')     as gross_profit,
         max(value) filter (where metric = 'cost_of_revenue')  as cost_of_revenue,
         max(value) filter (where metric = 'operating_income') as operating_income,
         max(value) filter (where metric = 'net_income')       as net_income,
         (array_agg(accession_no order by filed desc))[1]      as accession_no
  from f group by cik, fiscal_year
)
select p.*, coalesce(p.gross_profit, p.revenue - p.cost_of_revenue) as gross_profit_or_derived,
       prev.revenue as prior_revenue
from p left join p prev on prev.cik = p.cik and prev.fiscal_year = p.fiscal_year - 1;

-- Rank companies by one measure. Returns the rows plus coverage, so the UI can say how many
-- companies had the figures needed.
create or replace function public.lab_rank(
  p_metric      text,
  p_fiscal_year int  default null,
  p_division    text default null,
  p_order       text default 'desc',
  p_limit       int  default 25
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_year int;
begin
  perform rag.require_allowed();
  if p_metric not in ('gross_margin', 'operating_margin', 'net_margin', 'revenue', 'net_income',
                      'operating_income', 'revenue_growth') then
    raise exception 'unknown metric %', p_metric;
  end if;
  -- Default: the most recent fiscal year that most companies have reported.
  v_year := coalesce(p_fiscal_year, (select fiscal_year from rag.financial_years
                                     where revenue is not null group by 1 order by count(*) desc, 1 desc limit 1));
  return (
    with base as (
      select y.*, c.ticker, c.name, rag.sic_division(c.sic) as division, c.sic_description,
             case p_metric
               when 'gross_margin'     then y.gross_profit_or_derived / nullif(y.revenue, 0)
               when 'operating_margin' then y.operating_income / nullif(y.revenue, 0)
               when 'net_margin'       then y.net_income / nullif(y.revenue, 0)
               when 'revenue'          then y.revenue
               when 'net_income'       then y.net_income
               when 'operating_income' then y.operating_income
               when 'revenue_growth'   then y.revenue / nullif(y.prior_revenue, 0) - 1
             end as v,
             case p_metric
               when 'gross_margin'     then y.gross_profit_or_derived
               when 'operating_margin' then y.operating_income
               when 'net_margin'       then y.net_income
               when 'revenue_growth'   then y.revenue
             end as numerator,
             case p_metric
               when 'revenue_growth' then y.prior_revenue
               when 'gross_margin' then y.revenue when 'operating_margin' then y.revenue
               when 'net_margin' then y.revenue
             end as denominator
      from rag.financial_years y
      join rag.companies c on c.cik = y.cik
      where y.fiscal_year = v_year
        and (p_division is null or rag.sic_division(c.sic) = p_division)
    ),
    ranked as (
      select b.*, row_number() over (order by case when p_order = 'asc' then b.v end asc,
                                              case when p_order <> 'asc' then b.v end desc, b.ticker) as rnk
      from base b where b.v is not null
    )
    select jsonb_build_object(
      'metric', p_metric, 'fiscal_year', v_year, 'division', p_division, 'order', p_order,
      'companies_in_scope', (select count(*) from base),
      'companies_ranked', (select count(*) from ranked),
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
          'rank', r.rnk, 'ticker', r.ticker, 'name', r.name, 'cik', r.cik, 'division', r.division,
          'industry', r.sic_description, 'value', r.v, 'numerator', r.numerator, 'denominator', r.denominator,
          'revenue', r.revenue, 'period_end', r.period_end, 'accession_no', r.accession_no) order by r.rnk)
        from ranked r where r.rnk <= least(greatest(p_limit, 1), 200)), '[]'::jsonb))
  );
end;
$$;

-- Years and sectors that have figures, for the Compare & rank controls.
create or replace function public.lab_rank_options() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform rag.require_allowed();
  return jsonb_build_object(
    'years', coalesce((select jsonb_agg(jsonb_build_object('year', fiscal_year, 'companies', n) order by fiscal_year desc)
                       from (select fiscal_year, count(*) n from rag.financial_years where revenue is not null
                             group by 1 having count(*) >= 5) x), '[]'::jsonb),
    'divisions', coalesce((select jsonb_agg(jsonb_build_object('division', d, 'companies', n) order by n desc)
                           from (select rag.sic_division(c.sic) d, count(distinct c.cik) n
                                 from rag.companies c where exists (select 1 from rag.financial_facts f where f.cik = c.cik)
                                 group by 1) x), '[]'::jsonb),
    'facts', (select count(*) from rag.financial_facts));
end;
$$;

revoke execute on function public.lab_rank(text, int, text, text, int) from public;
revoke execute on function public.lab_rank_options() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function public.lab_rank(text, int, text, text, int) from anon';
    execute 'revoke execute on function public.lab_rank_options() from anon';
    execute 'grant execute on function public.lab_rank(text, int, text, text, int) to authenticated';
    execute 'grant execute on function public.lab_rank_options() to authenticated';
  end if;
end $$;
