-- migrate:up

-- M5 — Process and goods set-up (docs/plans/phase-2.md, decisions D16–D23).
--
-- A production process belongs to one period version. It has a main goods category, up to
-- five included categories (relevant precursors made inside the same boundary), production
-- per route of the main category (the activity level), goods (CN codes of the main category)
-- with their qualifying parameters, and the quantities consumed by other processes or for
-- non-CBAM goods. Every code is checked by a foreign key against the library version the
-- period pins (G8, G9), so a cement CN code cannot sit on an aluminium process (M5 AT1).

-- ---------------------------------------------------------------------------
-- M4 additions (D18, D19)
-- ---------------------------------------------------------------------------

-- Qualifying parameters: whether a value is required, and what kind of value it is.
alter table qualifying_parameter_def
  add column required    boolean not null default false,
  add column value_kind  text not null default 'number' check (value_kind in ('number', 'text', 'choice')),
  add column dimension   text check (dimension in ('fraction', 'mass_ratio')),
  add column choices     text[];

-- Back-fill every existing version, published ones included (D18): the only change ever made
-- to published content, and only to add these attributes. User triggers are off so the
-- freeze guard and the audit trigger (which needs a request context) do not fire, and row
-- security is not forced, so the owner sees the rows (the policies admit only library admins).
alter table qualifying_parameter_def disable trigger user;
alter table qualifying_parameter_def no force row level security;
update qualifying_parameter_def set
  value_kind = case
    when name like 'The main reducing agent%' or name = 'Calcined or not' then 'choice'
    when name = 'Steel mill identification number' then 'text'
    else 'number' end,
  dimension = case
    when name like 'The main reducing agent%' or name in ('Calcined or not', 'Steel mill identification number') then null
    when name like 't scrap per t %' then 'mass_ratio'
    else 'fraction' end,
  choices = case
    when name like 'The main reducing agent%' then array['Coal or coke', 'Natural gas', 'Biogas', 'Hydrogen']  -- CONST_ReducingAgent
    when name = 'Calcined or not' then array['Calcined', 'Not calcined'] end,
  required = not (name like '%if known%' or name like '%if hydrous solution%' or name = 'Steel mill identification number');
alter table qualifying_parameter_def force row level security;
alter table qualifying_parameter_def enable trigger user;

alter table qualifying_parameter_def
  alter column required drop default,
  alter column value_kind drop default,
  add constraint qualifying_parameter_def_number_dimension check ((value_kind = 'number') = (dimension is not null)),
  add constraint qualifying_parameter_def_choices
    check ((value_kind = 'choice') = (choices is not null)
           and (choices is null or cardinality(choices) between 2 and 20));

-- Versioned settings (D19). One row per key per version; frozen with the version.
create table library_setting (
  id                  uuid primary key default gen_random_uuid(),
  library_version_id  uuid not null references library_version (id) on delete cascade,
  key                 text not null check (key in ('production_balance_tolerance')),
  value               numeric not null,
  created_at          timestamptz not null,
  created_by          uuid not null,
  updated_at          timestamptz not null,
  updated_by          uuid not null,
  unique (library_version_id, key),
  -- A fraction of the activity level; beyond 20 % the balance check means nothing.
  constraint library_setting_tolerance
    check (key <> 'production_balance_tolerance' or value between 0 and 0.2)
);
-- Seed every existing version (D19). Row security on library_version is lifted for the read:
-- its policies admit only cbam_app, so the owner would see no rows.
alter table library_version no force row level security;
insert into library_setting (library_version_id, key, value, created_at, created_by, updated_at, updated_by)
select id, 'production_balance_tolerance', 0.005, now(), '00000000-0000-0000-0000-000000000000',
       now(), '00000000-0000-0000-0000-000000000000'
  from library_version;
alter table library_version force row level security;
select app.register_business_table('public.library_setting');
create trigger guard_library_content before insert or update or delete on library_setting
  for each row execute function app.guard_library_content();
create policy library_setting_read on library_setting for select to cbam_app using (true);
create policy library_setting_insert on library_setting for insert to cbam_app with check ((select app.is_library_admin()));
create policy library_setting_update on library_setting for update to cbam_app
  using ((select app.is_library_admin())) with check ((select app.is_library_admin()));
create policy library_setting_delete on library_setting for delete to cbam_app using ((select app.is_library_admin()));
grant select, insert, update, delete on library_setting to cbam_app;

-- New drafts copy the new columns and the settings.
create or replace function app.clone_library_content(p_from uuid, p_to uuid) returns void
  language plpgsql
  as $$
begin
  insert into goods_category (library_version_id, code, name, template_name, sector, unit,
                              indirect_relevant_definitive, indirect_relevant_transitional, route_relevant, sort_order)
  select p_to, code, name, template_name, sector, unit,
         indirect_relevant_definitive, indirect_relevant_transitional, route_relevant, sort_order
    from goods_category where library_version_id = p_from;
  insert into production_route (library_version_id, goods_category_code, code, name, sort_order)
  select p_to, goods_category_code, code, name, sort_order
    from production_route where library_version_id = p_from;
  insert into route_relevant_precursor (library_version_id, goods_category_code, route_code, precursor_category_code)
  select p_to, goods_category_code, route_code, precursor_category_code
    from route_relevant_precursor where library_version_id = p_from;
  insert into qualifying_parameter_def (library_version_id, goods_category_code, position, name,
                                        required, value_kind, dimension, choices)
  select p_to, goods_category_code, position, name, required, value_kind, dimension, choices
    from qualifying_parameter_def where library_version_id = p_from;
  insert into cn_code (library_version_id, code, description, goods_category_code)
  select p_to, code, description, goods_category_code
    from cn_code where library_version_id = p_from;
  insert into library_factor (library_version_id, kind, subject, country_code, region, year, component,
                              value, unit, value_si, si_unit, plausible_min, plausible_max,
                              valid_from, valid_to, source, notes)
  select p_to, kind, subject, country_code, region, year, component,
         value, unit, value_si, si_unit, plausible_min, plausible_max,
         valid_from, valid_to, source, notes
    from library_factor where library_version_id = p_from;
  insert into library_setting (library_version_id, key, value)
  select p_to, key, value from library_setting where library_version_id = p_from;
end
$$;

-- Targets for the M5 foreign keys: a CN code with its category (M5-R2), and a period version
-- with its pinned library (D23).
alter table cn_code add constraint cn_code_with_category unique (library_version_id, code, goods_category_code);
alter table period_version add constraint period_version_scope
  unique (id, installation_id, client_id, tenant_id, library_version_id);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- G5/G7 quantity column group: all empty, or value, unit, normalised value, source and
-- provenance all given; a default value names the library entry it came from.
create function app.quantity_ok(p_value numeric, p_unit text, p_si numeric, p_source text,
                                p_provenance text, p_default_ref uuid) returns boolean
  language sql immutable
  as $$
    select case
      when p_value is null then p_unit is null and p_si is null and p_source is null
                                and p_provenance is null and p_default_ref is null
      else p_unit is not null and p_si is not null
           and length(btrim(coalesce(p_source, ''))) between 1 and 500
           and p_provenance in ('measured', 'estimated', 'default')
           and (p_provenance <> 'default' or p_default_ref is not null)
    end
  $$;

-- Quantities in M5 are amounts: never negative.
create function app.amount_ok(p_value numeric, p_unit text, p_si numeric, p_source text,
                              p_provenance text, p_default_ref uuid) returns boolean
  language sql immutable
  as $$ select app.quantity_ok(p_value, p_unit, p_si, p_source, p_provenance, p_default_ref)
               and (p_value is null or (p_value >= 0 and p_si >= 0)) $$;

-- D16: an included category must be a relevant precursor of the main category, directly or
-- through other precursors, in the given library version (G9).
create function app.is_relevant_precursor(p_library_version_id uuid, p_main text, p_candidate text) returns boolean
  language sql stable
  as $$
    with recursive prec (code) as (
      select precursor_category_code from route_relevant_precursor
       where library_version_id = p_library_version_id and goods_category_code = p_main
      union
      select r.precursor_category_code from route_relevant_precursor r join prec on r.goods_category_code = prec.code
       where r.library_version_id = p_library_version_id
    )
    select exists (select 1 from prec where code = p_candidate)
  $$;

-- Who enters process data (D21): the set-up roles plus contributors of the installation.
create function app.can_enter_data() returns boolean
  language sql stable
  as $$ select app.current_user_role() in ('platform_admin', 'consultant', 'contributor') $$;

-- D21: contributors enter data but never change the set-up. Arguments: the data columns a
-- contributor may change. Admins and consultants may change anything the policies allow.
create function app.guard_setup_columns() returns trigger
  language plpgsql
  as $$
declare
  v_ignore text[] := array['updated_at', 'updated_by'] || coalesce(tg_argv::text[], '{}');
begin
  if app.current_user_role() in ('platform_admin', 'consultant') then
    return new;
  end if;
  if (to_jsonb(new) - v_ignore) is distinct from (to_jsonb(old) - v_ignore) then
    raise exception 'Your role can enter data but cannot change the set-up of a process'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- production_process (D16, D20)
-- ---------------------------------------------------------------------------

create table production_process (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null,
  client_id              uuid not null,
  installation_id        uuid not null,
  period_version_id      uuid not null,
  library_version_id     uuid not null,
  -- P1–P10 in the template.
  position               smallint not null check (position between 1 and 10),
  name                   text not null check (length(btrim(name)) between 1 and 200),
  goods_category_code    text not null,
  -- D_Processes (d): consumed for non-CBAM goods within the installation.
  non_cbam_value         numeric,
  non_cbam_unit          text,
  non_cbam_si            numeric,
  non_cbam_source        text,
  non_cbam_provenance    text,
  non_cbam_default_ref   uuid,
  status                 text not null default 'draft' check (status in ('draft', 'complete')),
  completed_at           timestamptz,
  completed_by           uuid,
  created_at             timestamptz not null,
  created_by             uuid not null,
  updated_at             timestamptz not null,
  updated_by             uuid not null,
  -- The pin cascades: if a draft's library version changes, every code below is re-checked (D23).
  foreign key (period_version_id, installation_id, client_id, tenant_id, library_version_id)
    references period_version (id, installation_id, client_id, tenant_id, library_version_id) on update cascade,
  foreign key (library_version_id, goods_category_code) references goods_category (library_version_id, code),
  unique (period_version_id, position),
  constraint production_process_scope unique (id, period_version_id, installation_id, client_id, tenant_id, library_version_id),
  constraint production_process_scope_category
    unique (id, period_version_id, installation_id, client_id, tenant_id, library_version_id, goods_category_code),
  constraint production_process_in_version unique (id, period_version_id),
  constraint production_process_non_cbam
    check (app.amount_ok(non_cbam_value, non_cbam_unit, non_cbam_si, non_cbam_source, non_cbam_provenance, non_cbam_default_ref)),
  check ((status = 'complete') = (completed_at is not null))
);
create unique index production_process_name on production_process (period_version_id, lower(btrim(name)));
create index production_process_version on production_process (period_version_id, position);

-- ---------------------------------------------------------------------------
-- process_included_category: precursors inside the boundary ("bubble"), with their routes.
-- ---------------------------------------------------------------------------

create table process_included_category (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  client_id            uuid not null,
  installation_id      uuid not null,
  period_version_id    uuid not null,
  library_version_id   uuid not null,
  process_id           uuid not null,
  goods_category_code  text not null,
  route_codes          text[] not null default '{}',
  created_at           timestamptz not null,
  created_by           uuid not null,
  updated_at           timestamptz not null,
  updated_by           uuid not null,
  foreign key (process_id, period_version_id, installation_id, client_id, tenant_id, library_version_id)
    references production_process (id, period_version_id, installation_id, client_id, tenant_id, library_version_id)
    on update cascade on delete cascade,
  foreign key (library_version_id, goods_category_code) references goods_category (library_version_id, code),
  unique (process_id, goods_category_code)
);
create index process_included_category_version on process_included_category (period_version_id);

-- ---------------------------------------------------------------------------
-- process_route: production of the main category per route (D_Processes (a)). The sum is
-- the activity level, the SEE denominator.
-- ---------------------------------------------------------------------------

create table process_route (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  client_id            uuid not null,
  installation_id      uuid not null,
  period_version_id    uuid not null,
  library_version_id   uuid not null,
  goods_category_code  text not null,
  process_id           uuid not null,
  -- Null only when the category is not route-relevant (checked by the trigger below).
  route_code           text,
  amount_value         numeric,
  amount_unit          text,
  amount_si            numeric,
  amount_source        text,
  amount_provenance    text,
  amount_default_ref   uuid,
  created_at           timestamptz not null,
  created_by           uuid not null,
  updated_at           timestamptz not null,
  updated_by           uuid not null,
  foreign key (process_id, period_version_id, installation_id, client_id, tenant_id, library_version_id, goods_category_code)
    references production_process (id, period_version_id, installation_id, client_id, tenant_id, library_version_id, goods_category_code)
    on update cascade on delete cascade,
  -- M5-R1: a route of the main category, from the pinned library.
  foreign key (library_version_id, goods_category_code, route_code)
    references production_route (library_version_id, goods_category_code, code),
  constraint process_route_unique unique nulls not distinct (process_id, route_code),
  constraint process_route_amount
    check (app.amount_ok(amount_value, amount_unit, amount_si, amount_source, amount_provenance, amount_default_ref))
);
create index process_route_version on process_route (period_version_id);

-- ---------------------------------------------------------------------------
-- process_good: CN codes the process makes (D17).
-- ---------------------------------------------------------------------------

create table process_good (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null,
  client_id              uuid not null,
  installation_id        uuid not null,
  period_version_id      uuid not null,
  library_version_id     uuid not null,
  goods_category_code    text not null,
  process_id             uuid not null,
  cn_code                char(8) not null,
  -- Summary_Products H: the name used with the reporting declarant (invoices).
  product_name           text check (length(btrim(product_name)) between 1 and 200),
  produced_value         numeric,
  produced_unit          text,
  produced_si            numeric,
  produced_source        text,
  produced_provenance    text,
  produced_default_ref   uuid,
  sold_eu_value          numeric,
  sold_eu_unit           text,
  sold_eu_si             numeric,
  sold_eu_source         text,
  sold_eu_provenance     text,
  sold_eu_default_ref    uuid,
  sold_other_value       numeric,
  sold_other_unit        text,
  sold_other_si          numeric,
  sold_other_source      text,
  sold_other_provenance  text,
  sold_other_default_ref uuid,
  created_at             timestamptz not null,
  created_by             uuid not null,
  updated_at             timestamptz not null,
  updated_by             uuid not null,
  foreign key (process_id, period_version_id, installation_id, client_id, tenant_id, library_version_id, goods_category_code)
    references production_process (id, period_version_id, installation_id, client_id, tenant_id, library_version_id, goods_category_code)
    on update cascade on delete cascade,
  -- M5-R2 / AT1: the CN code exists in the pinned library and belongs to the main category.
  foreign key (library_version_id, cn_code, goods_category_code)
    references cn_code (library_version_id, code, goods_category_code),
  constraint process_good_unique unique nulls not distinct (process_id, cn_code, product_name),
  constraint process_good_scope
    unique (id, period_version_id, installation_id, client_id, tenant_id, library_version_id, goods_category_code),
  constraint process_good_produced
    check (app.amount_ok(produced_value, produced_unit, produced_si, produced_source, produced_provenance, produced_default_ref)),
  constraint process_good_sold_eu
    check (app.amount_ok(sold_eu_value, sold_eu_unit, sold_eu_si, sold_eu_source, sold_eu_provenance, sold_eu_default_ref)),
  constraint process_good_sold_other
    check (app.amount_ok(sold_other_value, sold_other_unit, sold_other_si, sold_other_source, sold_other_provenance, sold_other_default_ref))
);
create index process_good_process on process_good (process_id);
create index process_good_version on process_good (period_version_id);

-- ---------------------------------------------------------------------------
-- process_good_parameter: qualifying parameter values (M5-R4, D18).
-- ---------------------------------------------------------------------------

create table process_good_parameter (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  client_id            uuid not null,
  installation_id      uuid not null,
  period_version_id    uuid not null,
  library_version_id   uuid not null,
  goods_category_code  text not null,
  good_id              uuid not null,
  position             smallint not null,
  value_text           text check (length(btrim(value_text)) between 1 and 200),
  value_value          numeric,
  value_unit           text,
  value_si             numeric,
  value_source         text,
  value_provenance     text,
  value_default_ref    uuid,
  created_at           timestamptz not null,
  created_by           uuid not null,
  updated_at           timestamptz not null,
  updated_by           uuid not null,
  foreign key (good_id, period_version_id, installation_id, client_id, tenant_id, library_version_id, goods_category_code)
    references process_good (id, period_version_id, installation_id, client_id, tenant_id, library_version_id, goods_category_code)
    on update cascade on delete cascade,
  foreign key (library_version_id, goods_category_code, position)
    references qualifying_parameter_def (library_version_id, goods_category_code, position),
  unique (good_id, position),
  check ((value_text is null) <> (value_value is null)),
  constraint process_good_parameter_value
    check (app.amount_ok(value_value, value_unit, value_si, value_source, value_provenance, value_default_ref))
);
create index process_good_parameter_version on process_good_parameter (period_version_id);

-- ---------------------------------------------------------------------------
-- process_internal_use: output of this process consumed by another process of the same
-- period version (D_Processes (c)).
-- ---------------------------------------------------------------------------

create table process_internal_use (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  client_id            uuid not null,
  installation_id      uuid not null,
  period_version_id    uuid not null,
  library_version_id   uuid not null,
  process_id           uuid not null,
  consumer_process_id  uuid not null,
  amount_value         numeric,
  amount_unit          text,
  amount_si            numeric,
  amount_source        text,
  amount_provenance    text,
  amount_default_ref   uuid,
  created_at           timestamptz not null,
  created_by           uuid not null,
  updated_at           timestamptz not null,
  updated_by           uuid not null,
  foreign key (process_id, period_version_id, installation_id, client_id, tenant_id, library_version_id)
    references production_process (id, period_version_id, installation_id, client_id, tenant_id, library_version_id)
    on update cascade on delete cascade,
  foreign key (consumer_process_id, period_version_id)
    references production_process (id, period_version_id) on delete cascade,
  unique (process_id, consumer_process_id),
  check (process_id <> consumer_process_id),
  constraint process_internal_use_amount
    check (app.amount_ok(amount_value, amount_unit, amount_si, amount_source, amount_provenance, amount_default_ref))
);
create index process_internal_use_consumer on process_internal_use (consumer_process_id);
create index process_internal_use_version on process_internal_use (period_version_id);

-- ---------------------------------------------------------------------------
-- Rules the foreign keys cannot express
-- ---------------------------------------------------------------------------

create function app.guard_production_process() returns trigger
  language plpgsql
  as $$
begin
  -- Only a status change sets or clears the completion stamp.
  if tg_op = 'INSERT' then
    new.status := 'draft';
  end if;
  if new.status = 'complete' and (tg_op = 'INSERT' or old.status <> 'complete') then
    if app.current_user_role() not in ('platform_admin', 'consultant') then
      raise exception 'Your role cannot mark a process complete' using errcode = 'insufficient_privilege';
    end if;
    new.completed_at := now();
    new.completed_by := app.current_user_id();
  elsif new.status = 'draft' then
    new.completed_at := null;
    new.completed_by := null;
  else
    new.completed_at := old.completed_at;
    new.completed_by := old.completed_by;
  end if;
  -- D16: the included categories must stay precursors of a new main category.
  if tg_op = 'UPDATE' and new.goods_category_code is distinct from old.goods_category_code
     and exists (select 1 from process_included_category c
                  where c.process_id = new.id
                    and (c.goods_category_code = new.goods_category_code
                         or not app.is_relevant_precursor(new.library_version_id, new.goods_category_code, c.goods_category_code))) then
    raise exception 'Remove the included categories that are not precursors of the new goods category first'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger guard_production_process before insert or update on production_process
  for each row execute function app.guard_production_process();
create trigger guard_setup_columns before update on production_process
  for each row execute function app.guard_setup_columns(
    'non_cbam_value', 'non_cbam_unit', 'non_cbam_si', 'non_cbam_source', 'non_cbam_provenance', 'non_cbam_default_ref',
    'status', 'completed_at', 'completed_by');

create function app.guard_process_included_category() returns trigger
  language plpgsql
  as $$
declare
  v_main text;
  v_bad  text;
begin
  select goods_category_code into v_main from production_process where id = new.process_id;
  if new.goods_category_code = v_main
     or not app.is_relevant_precursor(new.library_version_id, v_main, new.goods_category_code) then
    raise exception 'Only relevant precursors of the process''s goods category can be included'
      using errcode = 'check_violation';
  end if;
  if cardinality(new.route_codes) <> (select count(distinct r) from unnest(new.route_codes) r) then
    raise exception 'A route is listed twice' using errcode = 'check_violation';
  end if;
  select r into v_bad from unnest(new.route_codes) r
   where not exists (select 1 from production_route p
                      where p.library_version_id = new.library_version_id
                        and p.goods_category_code = new.goods_category_code and p.code = r)
   limit 1;
  if v_bad is not null then
    raise exception 'Route % is not a route of this goods category', v_bad using errcode = 'foreign_key_violation';
  end if;
  -- Six categories per process in the template: the main one and five included.
  if tg_op = 'INSERT' and (select count(*) from process_included_category where process_id = new.process_id) >= 5 then
    raise exception 'A process can include at most five other goods categories' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger guard_process_included_category before insert or update on process_included_category
  for each row execute function app.guard_process_included_category();

-- M5-R1: a route-relevant category has named routes; any other category has one row, no route.
create function app.guard_process_route() returns trigger
  language plpgsql
  as $$
declare
  v_relevant boolean;
begin
  select route_relevant into v_relevant from goods_category
   where library_version_id = new.library_version_id and code = new.goods_category_code;
  if v_relevant and new.route_code is null then
    raise exception 'Choose a production route' using errcode = 'check_violation';
  end if;
  if not v_relevant and new.route_code is not null then
    raise exception 'This goods category has no production routes' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger guard_process_route before insert or update on process_route
  for each row execute function app.guard_process_route();
create trigger guard_setup_columns before update on process_route
  for each row execute function app.guard_setup_columns(
    'amount_value', 'amount_unit', 'amount_si', 'amount_source', 'amount_provenance', 'amount_default_ref');

create trigger guard_setup_columns before update on process_good
  for each row execute function app.guard_setup_columns(
    'produced_value', 'produced_unit', 'produced_si', 'produced_source', 'produced_provenance', 'produced_default_ref',
    'sold_eu_value', 'sold_eu_unit', 'sold_eu_si', 'sold_eu_source', 'sold_eu_provenance', 'sold_eu_default_ref',
    'sold_other_value', 'sold_other_unit', 'sold_other_si', 'sold_other_source', 'sold_other_provenance', 'sold_other_default_ref');

-- D18: the value matches the kind of parameter configured in M4.
create function app.guard_process_good_parameter() returns trigger
  language plpgsql
  as $$
declare
  v_def record;
begin
  select value_kind, choices into v_def from qualifying_parameter_def
   where library_version_id = new.library_version_id and goods_category_code = new.goods_category_code
     and position = new.position;
  if v_def.value_kind = 'number' and new.value_value is null then
    raise exception 'This qualifying parameter takes a number' using errcode = 'check_violation';
  end if;
  if v_def.value_kind in ('text', 'choice') and new.value_text is null then
    raise exception 'This qualifying parameter takes text' using errcode = 'check_violation';
  end if;
  if v_def.value_kind = 'choice' and not (new.value_text = any (v_def.choices)) then
    raise exception 'Choose one of the listed values' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger guard_process_good_parameter before insert or update on process_good_parameter
  for each row execute function app.guard_process_good_parameter();

-- Nothing moves to another client (G1).
create trigger production_process_fixed_client before update on production_process
  for each row execute function app.forbid_client_change();

-- ---------------------------------------------------------------------------
-- Register: row metadata, audit, forced RLS, the period lock (G3, G4)
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['production_process', 'process_included_category', 'process_route', 'process_good',
                           'process_good_parameter', 'process_internal_use'] loop
    perform app.register_business_table(('public.' || t)::regclass);
    perform app.register_period_table(('public.' || t)::regclass);
  end loop;
end
$$;

-- M13: evidence can support a process or a good.
insert into app.evidence_linkable (table_name, label) values
  ('production_process', 'Production process'),
  ('process_good', 'Good');

-- ---------------------------------------------------------------------------
-- Policies (G1, G2, D21). Everyone but recipients reads what they can see of the
-- installation. Set-up rows are inserted and deleted by admins and consultants; data rows
-- by contributors too. The guard_setup_columns trigger limits what contributors update.
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['production_process', 'process_included_category', 'process_route', 'process_good',
                           'process_good_parameter', 'process_internal_use'] loop
    execute format($p$
      create policy %1$I on %2$I for select to cbam_app
        using (tenant_id = app.current_tenant_id() and app.current_user_role() <> 'recipient'
               and app.installation_visible(client_id, installation_id))$p$, t || '_read', t);
  end loop;
  foreach t in array array['production_process', 'process_included_category', 'process_route', 'process_good'] loop
    execute format($p$
      create policy %1$I on %2$I for insert to cbam_app
        with check (tenant_id = app.current_tenant_id() and app.can_manage_registry()
                    and app.installation_visible(client_id, installation_id))$p$, t || '_insert', t);
    execute format($p$
      create policy %1$I on %2$I for delete to cbam_app
        using (tenant_id = app.current_tenant_id() and app.can_manage_registry()
               and app.installation_visible(client_id, installation_id))$p$, t || '_delete', t);
  end loop;
  foreach t in array array['production_process', 'process_route', 'process_good'] loop
    execute format($p$
      create policy %1$I on %2$I for update to cbam_app
        using (tenant_id = app.current_tenant_id() and app.can_enter_data()
               and app.installation_visible(client_id, installation_id))
        with check (tenant_id = app.current_tenant_id())$p$, t || '_update', t);
  end loop;
  execute $p$
    create policy process_included_category_update on process_included_category for update to cbam_app
      using (tenant_id = app.current_tenant_id() and app.can_manage_registry()
             and app.installation_visible(client_id, installation_id))
      with check (tenant_id = app.current_tenant_id())$p$;
  foreach t in array array['process_good_parameter', 'process_internal_use'] loop
    execute format($p$
      create policy %1$I on %2$I for all to cbam_app
        using (tenant_id = app.current_tenant_id() and app.can_enter_data()
               and app.installation_visible(client_id, installation_id))
        with check (tenant_id = app.current_tenant_id() and app.can_enter_data()
                    and app.installation_visible(client_id, installation_id))$p$, t || '_write', t);
  end loop;
end
$$;

grant select, insert, update, delete on production_process, process_included_category, process_route, process_good,
  process_good_parameter, process_internal_use to cbam_app;

-- Foreign-key cascades (deleting a process deletes its routes and goods; a pin change updates
-- every row) run as the table owner, and each cascaded row passes the period lock trigger, which
-- calls app.assert_period_writable. Only its owner, cbam_auth, can grant that.
set role cbam_auth;
grant execute on function app.assert_period_writable(uuid) to cbam_owner;
reset role;

-- migrate:down

set role cbam_auth;
revoke execute on function app.assert_period_writable(uuid) from cbam_owner;
reset role;

delete from app.evidence_linkable where table_name in ('production_process', 'process_good');
drop table process_internal_use;
drop table process_good_parameter;
drop table process_good;
drop table process_route;
drop table process_included_category;
drop table production_process;
drop function app.guard_process_good_parameter();
drop function app.guard_process_route();
drop function app.guard_process_included_category();
drop function app.guard_production_process();
drop function app.guard_setup_columns();
drop function app.can_enter_data();
drop function app.is_relevant_precursor(uuid, text, text);
drop function app.amount_ok(numeric, text, numeric, text, text, uuid);
drop function app.quantity_ok(numeric, text, numeric, text, text, uuid);
alter table period_version drop constraint period_version_scope;
alter table cn_code drop constraint cn_code_with_category;
create or replace function app.clone_library_content(p_from uuid, p_to uuid) returns void
  language plpgsql
  as $$
begin
  insert into goods_category (library_version_id, code, name, template_name, sector, unit,
                              indirect_relevant_definitive, indirect_relevant_transitional, route_relevant, sort_order)
  select p_to, code, name, template_name, sector, unit,
         indirect_relevant_definitive, indirect_relevant_transitional, route_relevant, sort_order
    from goods_category where library_version_id = p_from;
  insert into production_route (library_version_id, goods_category_code, code, name, sort_order)
  select p_to, goods_category_code, code, name, sort_order
    from production_route where library_version_id = p_from;
  insert into route_relevant_precursor (library_version_id, goods_category_code, route_code, precursor_category_code)
  select p_to, goods_category_code, route_code, precursor_category_code
    from route_relevant_precursor where library_version_id = p_from;
  insert into qualifying_parameter_def (library_version_id, goods_category_code, position, name)
  select p_to, goods_category_code, position, name
    from qualifying_parameter_def where library_version_id = p_from;
  insert into cn_code (library_version_id, code, description, goods_category_code)
  select p_to, code, description, goods_category_code
    from cn_code where library_version_id = p_from;
  insert into library_factor (library_version_id, kind, subject, country_code, region, year, component,
                              value, unit, value_si, si_unit, plausible_min, plausible_max,
                              valid_from, valid_to, source, notes)
  select p_to, kind, subject, country_code, region, year, component,
         value, unit, value_si, si_unit, plausible_min, plausible_max,
         valid_from, valid_to, source, notes
    from library_factor where library_version_id = p_from;
end
$$;
drop table library_setting;
alter table qualifying_parameter_def
  drop constraint qualifying_parameter_def_choices,
  drop constraint qualifying_parameter_def_number_dimension,
  drop column choices,
  drop column dimension,
  drop column value_kind,
  drop column required;
