-- migrate:up

-- M4 — Reference library. Platform-wide (decision D1): every role reads it, only the
-- platform admin writes it. Client-specific factor overrides carry tenant_id and client_id.
--
-- Versioning (M4-R2, M4-R3): all library content belongs to one library_version. A new
-- version starts as a draft copied from the current published version; publishing makes
-- it immutable. Periods (M3) and results (M10) pin a version id, so publishing never
-- changes what an earlier period or result used.

-- Library rows have no tenant_id; their audit entries take the acting user's tenant so
-- the tenant's audit trail shows who changed the library.
create or replace function audit.log_row_change() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $$
declare
  v_user    uuid := app.current_user_id();
  v_old     jsonb;
  v_new     jsonb;
  v_row     jsonb;
  v_changed text[];
  v_key     text;
begin
  if v_user is null then
    raise exception 'Write to %.% without a request context: app.user_id is not set',
      tg_table_schema, tg_table_name
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;

  if tg_op = 'UPDATE' then
    select array_agg(n.key order by n.key)
      into v_changed
      from jsonb_each(v_new) n
     where n.value is distinct from v_old -> n.key
       and n.key not in ('updated_at', 'updated_by');
    if v_changed is null then
      return null;  -- nothing but metadata changed
    end if;
  end if;

  foreach v_key in array coalesce(tg_argv::text[], '{}') loop
    if v_old ? v_key then v_old := jsonb_set(v_old, array[v_key], '"[redacted]"'); end if;
    if v_new ? v_key then v_new := jsonb_set(v_new, array[v_key], '"[redacted]"'); end if;
  end loop;

  v_row := coalesce(v_new, v_old);

  insert into audit.audit_log
    (tenant_id, client_id, actor_user_id, actor_role, action, op, table_name, record_id,
     old_row, new_row, changed_fields, request_id, reason)
  values (
    coalesce((v_row ->> 'tenant_id')::uuid,
             case when tg_table_name = 'tenant' then (v_row ->> 'id')::uuid end,
             app.current_tenant_id()),
    coalesce(v_row ->> 'client_id', case when tg_table_name = 'client' then v_row ->> 'id' end)::uuid,
    v_user,
    app.current_user_role(),
    nullif(current_setting('app.action', true), ''),
    tg_op,
    tg_table_schema || '.' || tg_table_name,
    v_row ->> 'id',
    v_old,
    v_new,
    v_changed,
    nullif(current_setting('app.request_id', true), ''),
    nullif(current_setting('app.reason', true), '')
  );
  return null;
end
$$;

create function app.is_platform_admin() returns boolean
  language sql stable
  as $$ select app.current_user_role() = 'platform_admin' $$;

-- ---------------------------------------------------------------------------
-- Platform operator (review M4 F2, decision D12). Every tenant's first user is a platform
-- admin, but the library is shared by all tenants, so only the admins of the one operator
-- tenant may change it. No operator set = nobody can change the library.
-- ---------------------------------------------------------------------------

alter table tenant add column is_platform_operator boolean not null default false;
create unique index tenant_one_platform_operator on tenant ((true)) where is_platform_operator;

create function app.is_library_admin() returns boolean
  language sql stable
  as $$
    select app.current_user_role() = 'platform_admin'
       and coalesce((select t.is_platform_operator from tenant t where t.id = app.current_tenant_id()), false)
  $$;

-- Sets the operator tenant by slug. Run by the owner (CLI), never by the app role; owned by
-- cbam_auth (BYPASSRLS) like auth.bootstrap_tenant. The nil user marks a system change.
create function auth.set_platform_operator(p_slug text) returns uuid
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp
  as $$
declare
  v_tenant uuid;
begin
  select id into v_tenant from tenant where slug = p_slug;
  if v_tenant is null then
    raise exception 'No tenant with slug %', p_slug using errcode = 'no_data_found';
  end if;
  perform set_config('app.user_id', '00000000-0000-0000-0000-000000000000', true);
  perform set_config('app.tenant_id', v_tenant::text, true);
  perform set_config('app.user_role', 'platform_admin', true);
  perform set_config('app.action', 'Set platform operator', true);
  update tenant set is_platform_operator = false where is_platform_operator and id <> v_tenant;
  update tenant set is_platform_operator = true where id = v_tenant and not is_platform_operator;
  return v_tenant;
end
$$;
revoke execute on function auth.set_platform_operator(text) from public;
alter function auth.set_platform_operator(text) owner to cbam_auth;
set local role cbam_auth;
grant execute on function auth.set_platform_operator(text) to cbam_owner;
reset role;

-- ---------------------------------------------------------------------------
-- template_version: official EU template releases the report generator (M12) fills.
-- Registered once, never changed; results pin the code (G8).
-- ---------------------------------------------------------------------------

create table template_version (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique check (code ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,39}$'),
  title        text not null check (length(btrim(title)) between 1 and 300),
  file_name    text not null check (length(btrim(file_name)) between 1 and 255),
  file_sha256  char(64) not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  released_on  date not null,
  source       text not null check (length(btrim(source)) between 1 and 500),
  created_at   timestamptz not null,
  created_by   uuid not null,
  updated_at   timestamptz not null,
  updated_by   uuid not null
);

-- ---------------------------------------------------------------------------
-- library_version (M4-R2). At most one draft at a time; published versions are frozen.
-- ---------------------------------------------------------------------------

create table library_version (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique check (code ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,39}$'),
  status        text not null default 'draft' check (status in ('draft', 'published')),
  based_on_id   uuid references library_version (id),
  notes         text check (length(notes) <= 2000),
  published_at  timestamptz,
  published_by  uuid,
  created_at    timestamptz not null,
  created_by    uuid not null,
  updated_at    timestamptz not null,
  updated_by    uuid not null,
  check ((status = 'published') = (published_at is not null and published_by is not null))
);
create unique index library_version_one_draft on library_version ((true)) where status = 'draft';

-- ---------------------------------------------------------------------------
-- Regulatory configuration (M4-R7), as in the template's Parameters_Constants sheet:
-- aggregated goods categories, whether indirect emissions count, production routes,
-- relevant precursors and qualifying parameters. The engine reads these; nothing is
-- hard-coded (G9).
-- ---------------------------------------------------------------------------

create table goods_category (
  id                              uuid primary key default gen_random_uuid(),
  library_version_id              uuid not null references library_version (id) on delete cascade,
  code                            text not null check (code ~ '^[a-z][a-z0-9_]{0,59}$'),
  name                            text not null check (length(btrim(name)) between 1 and 200),
  template_name                   text not null check (length(template_name) between 1 and 200),  -- exact template text, for export
  sector                          text not null check (sector in ('cement', 'iron_steel', 'aluminium', 'fertilisers', 'hydrogen', 'electricity')),
  unit                            text not null check (unit in ('t', 'MWh')),
  indirect_relevant_definitive    boolean not null,
  indirect_relevant_transitional  boolean not null,
  route_relevant                  boolean not null,
  sort_order                      integer not null,
  created_at                      timestamptz not null,
  created_by                      uuid not null,
  updated_at                      timestamptz not null,
  updated_by                      uuid not null,
  unique (library_version_id, code)
);

create table production_route (
  id                   uuid primary key default gen_random_uuid(),
  library_version_id   uuid not null,
  goods_category_code  text not null,
  code                 text not null check (code ~ '^[a-z][a-z0-9_]{0,79}$'),
  name                 text not null check (length(btrim(name)) between 1 and 200),
  sort_order           integer not null,
  created_at           timestamptz not null,
  created_by           uuid not null,
  updated_at           timestamptz not null,
  updated_by           uuid not null,
  foreign key (library_version_id, goods_category_code)
    references goods_category (library_version_id, code) on delete cascade,
  unique (library_version_id, goods_category_code, code)
);

-- route_code null: relevant for every route of the category (the template's case).
create table route_relevant_precursor (
  id                       uuid primary key default gen_random_uuid(),
  library_version_id       uuid not null,
  goods_category_code      text not null,
  route_code               text,
  precursor_category_code  text not null,
  created_at               timestamptz not null,
  created_by               uuid not null,
  updated_at               timestamptz not null,
  updated_by               uuid not null,
  foreign key (library_version_id, goods_category_code)
    references goods_category (library_version_id, code) on delete cascade,
  foreign key (library_version_id, precursor_category_code)
    references goods_category (library_version_id, code) on delete cascade,
  foreign key (library_version_id, goods_category_code, route_code)
    references production_route (library_version_id, goods_category_code, code) on delete cascade,
  check (precursor_category_code <> goods_category_code),
  constraint route_relevant_precursor_unique_key
    unique nulls not distinct (library_version_id, goods_category_code, route_code, precursor_category_code)
);

create table qualifying_parameter_def (
  id                   uuid primary key default gen_random_uuid(),
  library_version_id   uuid not null,
  goods_category_code  text not null,
  position             smallint not null check (position between 1 and 8),
  name                 text not null check (length(btrim(name)) between 1 and 200),
  created_at           timestamptz not null,
  created_by           uuid not null,
  updated_at           timestamptz not null,
  updated_by           uuid not null,
  foreign key (library_version_id, goods_category_code)
    references goods_category (library_version_id, code) on delete cascade,
  unique (library_version_id, goods_category_code, position)
);

create table cn_code (
  id                   uuid primary key default gen_random_uuid(),
  library_version_id   uuid not null,
  code                 char(8) not null check (code ~ '^[0-9]{8}$'),
  description          text not null check (length(btrim(description)) between 1 and 1000),
  goods_category_code  text not null,
  created_at           timestamptz not null,
  created_by           uuid not null,
  updated_at           timestamptz not null,
  updated_by           uuid not null,
  foreign key (library_version_id, goods_category_code)
    references goods_category (library_version_id, code) on delete cascade,
  unique (library_version_id, code)
);

-- ---------------------------------------------------------------------------
-- library_factor (M4-R1, R6, R8): emission factors, NCVs, GWPs, grid factors and default
-- SEE values in one table (decision D7). The natural key is kind + subject + country +
-- region + year + component; one row per key per version. Values are stored as entered
-- and in the SI unit (G5). The plausible range is in the same unit as the value.
-- ---------------------------------------------------------------------------

create table library_factor (
  id                  uuid primary key default gen_random_uuid(),
  library_version_id  uuid not null references library_version (id) on delete cascade,
  kind                text not null check (kind in ('emission_factor', 'ncv', 'gwp', 'grid_factor', 'default_see')),
  subject             text not null check (length(btrim(subject)) between 1 and 200),
  country_code        char(2) references ref_country (code),
  region              text check (length(btrim(region)) between 1 and 100),
  year                smallint check (year between 1990 and 2100),
  component           text check (component in ('direct', 'indirect')),
  value               numeric not null check (value >= 0),
  unit                text not null check (length(unit) between 1 and 40),
  value_si            numeric not null check (value_si >= 0),
  si_unit             text not null check (length(si_unit) between 1 and 40),
  plausible_min       numeric check (plausible_min >= 0),
  plausible_max       numeric check (plausible_max >= 0),
  valid_from          date not null,
  valid_to            date,
  source              text not null check (length(btrim(source)) between 1 and 500),
  notes               text check (length(notes) <= 1000),
  created_at          timestamptz not null,
  created_by          uuid not null,
  updated_at          timestamptz not null,
  updated_by          uuid not null,
  check (plausible_min is null or plausible_max is null or plausible_min <= plausible_max),
  check (valid_to is null or valid_to >= valid_from),
  -- M4-R6: grid factors by country (and region) and year.
  check (kind <> 'grid_factor' or (country_code is not null and year is not null)),
  check (kind = 'grid_factor' or region is null),
  -- Default values are per CN code and split into direct and indirect.
  check ((kind = 'default_see') = (component is not null)),
  check (kind <> 'default_see' or subject ~ '^[0-9]{8}$'),
  constraint library_factor_unique_key
    unique nulls not distinct (library_version_id, kind, subject, country_code, region, year, component)
);
create index library_factor_lookup on library_factor (library_version_id, kind, subject);

-- ---------------------------------------------------------------------------
-- library_import (M4-R4): an uploaded file, validated and diffed against the draft.
-- The parsed rows are kept until applied; they are redacted from the audit log (the
-- rows themselves are audited when applied).
-- ---------------------------------------------------------------------------

create table library_import (
  id                  uuid primary key default gen_random_uuid(),
  library_version_id  uuid not null references library_version (id) on delete cascade,
  dataset             text not null check (dataset in ('factors', 'cn_codes')),
  file_name           text not null check (length(btrim(file_name)) between 1 and 255),
  file_sha256         char(64) not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  row_count           integer not null check (row_count >= 0),
  status              text not null default 'previewed' check (status in ('previewed', 'applied')),
  base_fingerprint    text not null,
  summary             jsonb not null,
  rows                jsonb not null,
  applied_at          timestamptz,
  created_at          timestamptz not null,
  created_by          uuid not null,
  updated_at          timestamptz not null,
  updated_by          uuid not null,
  check ((status = 'applied') = (applied_at is not null))
);

-- ---------------------------------------------------------------------------
-- client_factor_override (M4-R5): a consultant proposes a client-specific value for a
-- library key; the platform admin approves or rejects it. Values never change after the
-- proposal: withdraw and propose again instead.
-- ---------------------------------------------------------------------------

create table client_factor_override (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  client_id      uuid not null,
  kind           text not null check (kind in ('emission_factor', 'ncv', 'gwp', 'grid_factor', 'default_see')),
  subject        text not null check (length(btrim(subject)) between 1 and 200),
  country_code   char(2) references ref_country (code),
  region         text check (length(btrim(region)) between 1 and 100),
  year           smallint check (year between 1990 and 2100),
  component      text check (component in ('direct', 'indirect')),
  value          numeric not null check (value >= 0),
  unit           text not null check (length(unit) between 1 and 40),
  value_si       numeric not null check (value_si >= 0),
  si_unit        text not null check (length(si_unit) between 1 and 40),
  valid_from     date not null,
  valid_to       date,
  source         text not null check (length(btrim(source)) between 1 and 500),
  justification  text not null check (length(btrim(justification)) between 1 and 1000),
  status         text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'withdrawn')),
  decided_by     uuid,
  decided_at     timestamptz,
  decision_note  text check (length(decision_note) <= 1000),
  created_at     timestamptz not null,
  created_by     uuid not null,
  updated_at     timestamptz not null,
  updated_by     uuid not null,
  foreign key (client_id, tenant_id) references client (id, tenant_id),
  check (valid_to is null or valid_to >= valid_from),
  check (kind <> 'grid_factor' or (country_code is not null and year is not null)),
  check (kind = 'grid_factor' or region is null),
  check ((kind = 'default_see') = (component is not null)),
  check (kind <> 'default_see' or subject ~ '^[0-9]{8}$'),
  -- Decided overrides keep their decision when later withdrawn.
  check (status not in ('approved', 'rejected') or decided_at is not null),
  check (status <> 'proposed' or decided_at is null)
);
create index client_factor_override_client on client_factor_override (client_id, status);
-- One live override per key and client.
create unique index client_factor_override_live on client_factor_override
  (client_id, kind, subject, country_code, region, year, component) nulls not distinct
  where status in ('proposed', 'approved');

-- ---------------------------------------------------------------------------
-- Seed: template 2026-Q2 and library version 2026.1 built from it. Loaded before the
-- tables are registered, so these rows carry the nil user as creator and no audit entry
-- (like ref_country). Only values printed in the template are seeded; NCVs, grid factors
-- and default values arrive by import (spec §11: licensing still open).
-- ---------------------------------------------------------------------------

insert into template_version (code, title, file_name, file_sha256, released_on, source,
                              created_at, created_by, updated_at, updated_by)
values ('2026-Q2',
        'CBAM Communication Template for Installations (SEE Communication V2, UBA, 13 Dec 2024)',
        'CBAM_Communication_Template_Installations_2026-Q2.xlsx',
        '5a4e28fdbccfdca45a2c0520184b551a20c0c7bba3db79f87d78c9e58a6c0917',
        '2024-12-13',
        'European Commission / Umweltbundesamt, sheet VersionDocumentation',
        now(), '00000000-0000-0000-0000-000000000000', now(), '00000000-0000-0000-0000-000000000000');

create temporary table seed_meta on commit drop as
select gen_random_uuid() as version_id,
       now() as at,
       '00000000-0000-0000-0000-000000000000'::uuid as by,
       'CBAM Communication Template 2026-Q2, Parameters_Constants'::text as src;

insert into library_version (id, code, status, notes, published_at, published_by,
                             created_at, created_by, updated_at, updated_by)
select version_id, '2026.1', 'published',
       'Initial library from the official template 2026-Q2: goods categories, routes, relevant precursors, qualifying parameters, CN codes, GWPs and the natural gas emission factor.',
       at, by, at, by, at, by
  from seed_meta;

insert into goods_category (library_version_id, code, name, template_name, sector, unit,
                            indirect_relevant_definitive, indirect_relevant_transitional,
                            route_relevant, sort_order, created_at, created_by, updated_at, updated_by)
select m.version_id, v.code, v.name,
       case v.code when 'calcined_clays' then 'Calcined clays ' else v.name end,  -- trailing space as in the template
       v.sector, v.unit, v.ind_def, v.ind_trans, v.route, v.sort, m.at, m.by, m.at, m.by
  from seed_meta m, (values
  ('cement', 'Cement', 'cement', 't', true, true, false, 1),
  ('cement_clinker', 'Cement clinker', 'cement', 't', true, true, false, 2),
  ('calcined_clays', 'Calcined clays', 'cement', 't', true, true, false, 3),
  ('aluminous_cement', 'Aluminous cement', 'cement', 't', true, true, false, 4),
  ('iron_steel_products', 'Iron or steel products', 'iron_steel', 't', false, true, false, 5),
  ('crude_steel', 'Crude steel', 'iron_steel', 't', false, true, true, 6),
  ('dri', 'Direct reduced iron', 'iron_steel', 't', false, true, false, 7),
  ('pig_iron', 'Pig iron', 'iron_steel', 't', false, true, true, 8),
  ('alloys', 'Alloys (FeMn, FeCr, FeNi)', 'iron_steel', 't', false, true, false, 9),
  ('sintered_ore', 'Sintered Ore', 'iron_steel', 't', true, true, false, 10),
  ('hydrogen', 'Hydrogen', 'hydrogen', 't', false, true, true, 11),
  ('ammonia', 'Ammonia', 'fertilisers', 't', false, true, true, 12),
  ('nitric_acid', 'Nitric acid', 'fertilisers', 't', true, true, false, 13),
  ('urea', 'Urea', 'fertilisers', 't', true, true, false, 14),
  ('mixed_fertilisers', 'Mixed fertilisers', 'fertilisers', 't', true, true, false, 15),
  ('aluminium_products', 'Aluminium products', 'aluminium', 't', false, true, false, 16),
  ('unwrought_aluminium', 'Unwrought aluminium', 'aluminium', 't', false, true, true, 17),
  ('electricity', 'Electricity (export to EU)', 'electricity', 'MWh', false, false, false, 18)
) as v (code, name, sector, unit, ind_def, ind_trans, route, sort);

insert into production_route (library_version_id, goods_category_code, code, name, sort_order,
                              created_at, created_by, updated_at, updated_by)
select m.version_id, v.cat, v.code, v.name, v.sort, m.at, m.by, m.at, m.by
  from seed_meta m, (values
  ('crude_steel', 'basic_oxygen_steelmaking', 'Basic oxygen steelmaking', 1),
  ('crude_steel', 'electric_arc_furnace', 'Electric arc furnace', 2),
  ('crude_steel', 'other', 'Other production routes', 3),
  ('crude_steel', 'unknown', 'Unknown production routes', 4),
  ('pig_iron', 'blast_furnace_route', 'Blast furnace route', 1),
  ('pig_iron', 'smelting_reduction', 'Smelting reduction', 2),
  ('pig_iron', 'other', 'Other production routes', 3),
  ('pig_iron', 'unknown', 'Unknown production routes', 4),
  ('hydrogen', 'steam_reforming_partial_oxidation', 'Steam reforming and partial oxidation', 1),
  ('hydrogen', 'electrolysis_of_water', 'Electrolysis of water', 2),
  ('hydrogen', 'chlor_alkali_electrolysis', 'Chlor-Alkali electrolysis and production of chlorates', 3),
  ('hydrogen', 'other', 'Other production routes', 4),
  ('hydrogen', 'unknown', 'Unknown production routes', 5),
  ('ammonia', 'haber_bosch_steam_reforming', 'Haber-Bosch process with steam reforming of natural gas or biogas', 1),
  ('ammonia', 'haber_bosch_gasification', 'Haber-Bosch process with gasification of coal or other fuels', 2),
  ('ammonia', 'other', 'Other production routes', 3),
  ('ammonia', 'unknown', 'Unknown production routes', 4),
  ('unwrought_aluminium', 'primary_smelting', 'Primary (electrolytic) smelting', 1),
  ('unwrought_aluminium', 'secondary_melting', 'Secondary melting (recycling)', 2),
  ('unwrought_aluminium', 'other', 'Other production routes', 3),
  ('unwrought_aluminium', 'unknown', 'Unknown production routes', 4)
) as v (cat, code, name, sort);

insert into route_relevant_precursor (library_version_id, goods_category_code, route_code, precursor_category_code,
                                      created_at, created_by, updated_at, updated_by)
select m.version_id, v.cat, null, v.prec, m.at, m.by, m.at, m.by
  from seed_meta m, (values
  ('cement', 'cement_clinker'),
  ('cement', 'calcined_clays'),
  ('iron_steel_products', 'crude_steel'),
  ('crude_steel', 'pig_iron'),
  ('crude_steel', 'dri'),
  ('crude_steel', 'alloys'),
  ('dri', 'sintered_ore'),
  ('dri', 'hydrogen'),
  ('pig_iron', 'sintered_ore'),
  ('pig_iron', 'alloys'),
  ('alloys', 'sintered_ore'),
  ('ammonia', 'hydrogen'),
  ('nitric_acid', 'ammonia'),
  ('urea', 'ammonia'),
  ('mixed_fertilisers', 'ammonia'),
  ('mixed_fertilisers', 'nitric_acid'),
  ('mixed_fertilisers', 'urea'),
  ('aluminium_products', 'unwrought_aluminium')
) as v (cat, prec);

insert into qualifying_parameter_def (library_version_id, goods_category_code, position, name,
                                      created_at, created_by, updated_at, updated_by)
select m.version_id, v.cat, v.pos, v.name, m.at, m.by, m.at, m.by
  from seed_meta m, (values
  ('cement', 2, 'Clinker factor'),
  ('calcined_clays', 2, 'Calcined or not'),
  ('iron_steel_products', 1, 'The main reducing agent of the precursor, if known'),
  ('iron_steel_products', 2, 'Steel mill identification number'),
  ('iron_steel_products', 3, '% Mn'),
  ('iron_steel_products', 4, '% Cr'),
  ('iron_steel_products', 5, '% Ni'),
  ('iron_steel_products', 6, '% other alloys'),
  ('iron_steel_products', 7, '% other materials'),
  ('crude_steel', 1, 'The main reducing agent of the precursor, if known'),
  ('crude_steel', 2, '% Mn'),
  ('crude_steel', 3, '% Cr'),
  ('crude_steel', 4, '% Ni'),
  ('crude_steel', 5, '% other alloys'),
  ('crude_steel', 6, 't scrap per t steel'),
  ('crude_steel', 7, '% pre-consumer scrap'),
  ('dri', 1, 'The main reducing agent of the precursor, if known'),
  ('dri', 2, '% Mn'),
  ('dri', 3, '% Cr'),
  ('dri', 4, '% Ni'),
  ('dri', 5, '% other alloys'),
  ('pig_iron', 1, 'The main reducing agent of the precursor, if known'),
  ('pig_iron', 2, '% Mn'),
  ('pig_iron', 3, '% Cr'),
  ('pig_iron', 4, '% Ni'),
  ('pig_iron', 5, '% other alloys'),
  ('alloys', 2, '% Mn'),
  ('alloys', 3, '% Cr'),
  ('alloys', 4, '% Ni'),
  ('alloys', 5, '% carbon'),
  ('ammonia', 2, 'Concentration, if hydrous solution'),
  ('nitric_acid', 2, '% nitric acid'),
  ('urea', 2, '% urea'),
  ('urea', 3, '% N contained'),
  ('mixed_fertilisers', 2, '% N as ammonium (NH4+)'),
  ('mixed_fertilisers', 3, '% N as nitrate (NO3–)'),
  ('mixed_fertilisers', 4, '% N as Urea'),
  ('mixed_fertilisers', 5, '% N in other (organic) forms'),
  ('aluminium_products', 2, 't scrap per t aluminium'),
  ('aluminium_products', 3, '% non-aluminium elements'),
  ('aluminium_products', 4, '% pre-consumer scrap'),
  ('unwrought_aluminium', 2, 't scrap per t aluminium'),
  ('unwrought_aluminium', 3, '% non-aluminium elements'),
  ('unwrought_aluminium', 4, '% pre-consumer scrap')
) as v (cat, pos, name);

insert into cn_code (library_version_id, code, description, goods_category_code,
                     created_at, created_by, updated_at, updated_by)
select m.version_id, v.code, v.description, v.cat, m.at, m.by, m.at, m.by
  from seed_meta m, (values
  ('25070080', 'Kaolinic clays (other than kaolin)', 'calcined_clays'),
  ('25231000', 'Cement clinkers', 'cement_clinker'),
  ('25232100', 'White portland cement, whether or not artificially coloured', 'cement'),
  ('25232900', 'Portland cement (excl. white, whether or not artificially coloured)', 'cement'),
  ('25233000', 'Aluminous cement', 'aluminous_cement'),
  ('25239000', 'Cement, whether or not coloured (excl. portland cement and aluminous cement)', 'cement'),
  ('26011200', 'Agglomerated iron ores and concentrates (excl. roasted iron pyrites)', 'sintered_ore'),
  ('28041000', 'Hydrogen', 'hydrogen'),
  ('28080000', 'Nitric acid; sulphonitric acids', 'nitric_acid'),
  ('28141000', 'Anhydrous ammonia', 'ammonia'),
  ('28142000', 'Ammonia in aqueous solution', 'ammonia'),
  ('28342100', 'Nitrate of potassium', 'mixed_fertilisers'),
  ('31021010', 'Urea, whether or not in aqueous solution, containing > 45% nitrogen in relation to the weight of the dry product (excl. that in tablets or similar forms, or in packages with a gross weight of <= 10 kg)', 'urea'),
  ('31021090', 'Urea, whether or not in aqueous solution, containing <= 45% by weight of nitrogen on the dry anhydrous product (excl. goods of this chapter in tablets or similar forms or in packages of a gross weight of <= 10 kg)', 'urea'),
  ('31022100', 'Ammonium sulphate (excl. that in tablets or similar forms, or in packages with a gross weight of <= 10 kg)', 'mixed_fertilisers'),
  ('31022900', 'Double salts and mixtures of ammonium sulphate and ammonium nitrate (excl. goods of this chapter in tablets or similar forms or in packages of a gross weight of <= 10 kg)', 'mixed_fertilisers'),
  ('31023010', 'Ammonium nitrate in aqueous solution (excl. that in packages with a gross weight of <= 10 kg)', 'mixed_fertilisers'),
  ('31023090', 'Ammonium nitrate (excl. that in aqueous solution, in tablets or similar forms, or in packages with a gross weight of <= 10 kg)', 'mixed_fertilisers'),
  ('31024010', 'Mixtures of ammonium nitrate with calcium carbonate or other inorganic non-fertilising substances, for use as fertilisers, containing <= 28% nitrogen by weight (excl. those in tablets or similar forms, or in packages with a gross weight of <= 10 kg)', 'mixed_fertilisers'),
  ('31024090', 'Mixtures of ammonium nitrate with calcium carbonate or other inorganic non-fertilising substances, for use as fertilisers, containing > 28% nitrogen by weight (excl. those in tablets or similar forms, or in packages with a gross weight of <= 10 kg)', 'mixed_fertilisers'),
  ('31025000', 'Sodium nitrate (excl. that in tablets or similar forms, or in packages with a gross weight of <= 10 kg)', 'mixed_fertilisers'),
  ('31026000', 'Double salts and mixtures of calcium nitrate and ammonium nitrate (excl. those in tablets or similar forms, or in packages with a gross weight of <= 10 kg)', 'mixed_fertilisers'),
  ('31028000', 'Mixtures of urea and ammonium nitrate in aqueous or ammoniacal solution (excl. those in packages with a gross weight of <= 10 kg)', 'mixed_fertilisers'),
  ('31029000', 'Mineral or chemical nitrogen fertilisers (excl. urea; ammonium sulphate; ammonium nitrate; sodium nitrate; double salts and mixtures of ammonium nitrate with ammonium sulphate or calcium; mixtures of urea and ammonium nitrate in aqueous or ammoniacal solution; mixtures of ammonium nitrate and calcium carbonate or other non-fertilising inorganic elements; in tablets or similar in packages <= 10 kg)', 'mixed_fertilisers'),
  ('31051000', 'Mineral or chemical fertilisers of animal or vegetable origin, in tablets or similar forms, or in packages with a gross weight of <= 10 kg', 'mixed_fertilisers'),
  ('31052010', 'Mineral or chemical fertilisers containing phosphorus and potassium, with a nitrogen content > 10 % by weight on the dry anhydrous product (excl. those in tablets or similar forms, or in packages with a gross weight of <= 10 kg)', 'mixed_fertilisers'),
  ('31052090', 'Mineral or chemical fertilisers containing nitrogen, phosphorus and potassium, with a nitrogen content <= 10 % by weight on the dry anhydrous product (excl. those in tablets or similar forms, or in packages with a gross weight of <= 10 kg)', 'mixed_fertilisers'),
  ('31053000', 'Diammonium hydrogenorthophosphate "diammonium phosphate" (excl. that in tablets or similar forms, or in packages with a gross weight of <= 10 kg)', 'mixed_fertilisers'),
  ('31054000', 'Ammonium dihydrogenorthophosphate "monoammonium phosphate", whether or not mixed with diammonium hydrogenorthophosphate "diammonium phosphate" (excl. that in tablets or similar forms, or in packages with a gross weight of <= 10 kg)', 'mixed_fertilisers'),
  ('31055100', 'Mineral or chemical fertilisers containing nitrates and phosphates (excl. ammonium dihydrogenorthophosphate "Monoammonium phosphate", diammonium hydrogenorthophosphate "Diammonium phosphate", and those in tablets or similar forms, or in packages with a gross weight of <= 10 kg)', 'mixed_fertilisers'),
  ('31055900', 'Mineral or chemical fertilisers containing the two fertilising elements nitrogen (excl. nitrate) and phosphorus but not nitrates (excl. ammonium dihydrogenorthophosphate "monoammonium phosphate", diammonium hydrogenorthophosphate "diammonium phosphate" in tablets or similar forms, or in packages with a gross weight of <= 10 kg)', 'mixed_fertilisers'),
  ('31059020', 'Mineral or chemical fertilisers containing the two fertilising elements nitrogen and potassium, or one principal fertilising substance only, incl. mixtures of animal or vegetable fertilisers with chemical or mineral fertilisers, containing > 10% nitrogen by weight (excl. in tablets or similar forms, or in packages with a gross weight of <= 10 kg)', 'mixed_fertilisers'),
  ('31059080', 'Mineral or chemical fertilisers containing the two fertilising elements nitrogen and potassium, or one main fertilising element, incl. mixtures of animal or vegetable fertilisers with chemical or mineral fertilisers, not containing nitrogen or with a nitrogen content, by weight, of <= 10% (excl. in tablets or similar forms or in packages of a gross weight of <= 10 kg)', 'mixed_fertilisers'),
  ('72011011', 'Non-alloy pig iron in pigs, blocks or other primary forms, containing by weight <= 0,5% phosphorus, >= 0,4% manganese and <= 1% silicon', 'pig_iron'),
  ('72011019', 'Non-alloy pig iron in pigs, blocks or other primary forms, containing by weight <= 0,5% phosphorus, >= 0,4% manganese and > 1% silicon', 'pig_iron'),
  ('72011030', 'Non-alloy pig iron in pigs, blocks or other primary forms, containing by weight <= 0,5% phosphorus, and >= 0,1% but < 0,4% manganese', 'pig_iron'),
  ('72011090', 'Non-alloy pig iron in pigs, blocks or other primary forms, containing by weight <= 0,5% phosphorus, and <= 0,1% manganese', 'pig_iron'),
  ('72012000', 'Non-alloy pig iron in pigs, blocks or other primary forms, containing by weight >= 0,5% phosphorus', 'pig_iron'),
  ('72015010', 'Alloy pig iron in pigs, blocks or other primary forms, containing by weight >= 0,3% but <= 1% titanium and >= 0,5% but <= 1% vanadium', 'pig_iron'),
  ('72015090', 'Alloy pig iron and spiegeleisen, in pigs, blocks or other primary forms (excl. alloy iron containing, by weight, >= 0,3% but <= 1% titanium and >= 0,5% but <= 1% vanadium)', 'pig_iron'),
  ('72021120', 'Ferro-manganese, containing by weight > 2% carbon, with a granulometry <= 5 mm and a manganese content by weight > 65%', 'alloys'),
  ('72021180', 'Ferro-manganese, containing by weight > 2% carbon (excl. ferro-manganese with a granulometry of <= 5 mm and containing by weight > 65% manganese)', 'alloys'),
  ('72021900', 'Ferro-manganese, containing by weight <= 2% carbon', 'alloys'),
  ('72024110', 'Ferro-chromium, containing by weight > 4% but <= 6% carbon', 'alloys'),
  ('72024190', 'Ferro-chromium, containing by weight > 6% carbon', 'alloys'),
  ('72024910', 'Ferro-chromium, containing by weight <= 0,05% carbon', 'alloys'),
  ('72024950', 'Ferro-chromium, containing by weight > 0,05% but <= 0,5% carbon', 'alloys'),
  ('72024990', 'Ferro-chromium, containing by weight > 0,5% but <= 4% carbon', 'alloys'),
  ('72026000', 'Ferro-nickel', 'alloys'),
  ('72031000', 'Ferrous products obtained by direct reduction of iron ore, in lumps, pellets or similar forms', 'dri'),
  ('72039000', 'Spongy ferrous products, obtained from molten pig iron by atomisation, iron of a purity of >= 99,94%, in lumps, pellets or similar forms', 'dri'),
  ('72051000', 'Granules, of pig iron, spiegeleisen, iron or steel (excl. granules of ferro-alloys, turnings and filings of iron or steel, certain small calibre items, defective balls for ball-bearings)', 'iron_steel_products'),
  ('72052100', 'Powders, of alloy steel (excl. powders of ferro-alloys and radioactive iron powders "isotopes")', 'iron_steel_products'),
  ('72052900', 'Powders, of pig iron, spiegeleisen, iron or non-alloy steel (excl. powders of ferro-alloys and radioactive iron powders "isotopes")', 'iron_steel_products'),
  ('72061000', 'Ingots, of iron and non-alloy steel (excl. remelted scrap ingots, continuous cast products, iron of heading 7203)', 'crude_steel'),
  ('72069000', 'Iron and non-alloy steel, in puddled bars or other primary forms (excl. ingots, remelted scrap ingots, continuous cast products, iron of heading 7203)', 'crude_steel'),
  ('72071111', 'Semi-finished products, of non-alloy free-cutting steel, containing by weight < 0,25% carbon, of square or rectangular cross-section, the width < twice the thickness, rolled or obtained by continuous casting', 'crude_steel'),
  ('72071114', 'Semi-finished products, of iron or non-alloy steel, containing by weight < 0,25% carbon, of square or rectangular cross-section, the width < twice the thickness of <= 130 mm, rolled or obtained by continuous casting (excl. free-cutting steel)', 'crude_steel'),
  ('72071116', 'Semi-finished products, of iron or non-alloy steel, containing by weight < 0,25% carbon, of square or rectangular cross-section, the width < twice the thickness of > 130 mm, rolled or obtained by continuous casting (excl. free-cutting steel)', 'crude_steel'),
  ('72071190', 'Semi-finished products of iron or non-alloy steel, containing by weight < 0,25% carbon, of rectangular cross-section, the width < twice the thickness, forged', 'crude_steel'),
  ('72071210', 'Semi-finished products of iron or non-alloy steel, containing by weight < 0,25 of carbon, of rectangular "other than square" cross-section, the width measuring >= twice the thickness, rolled or obtained by continuous casting', 'crude_steel'),
  ('72071290', 'Semi-finished products of iron or non-alloy steel, containing by weight < 0,25% carbon, of rectangular "other than square" cross-section, the width >= twice the thickness, forged', 'crude_steel'),
  ('72071912', 'Semi-finished products, of iron or non-alloy steel, containing by weight < 0,25% carbon, of circular or polygonal cross-section, rolled or obtained by continuous casting', 'crude_steel'),
  ('72071919', 'Semi-finished products of iron or non-alloy steel, containing by weight < 0,25% carbon, of circular or polygonal cross-section, forged', 'crude_steel'),
  ('72071980', 'Semi-finished products of iron or non-alloy steel, containing by weight < 0,25% carbon (excl. semi-products, of square, rectangular, circular or polygonal cross-section)', 'crude_steel'),
  ('72072011', 'Semi-finished products, of non-alloy free-cutting steel, containing by weight >= 0,25% carbon, of square or rectangular cross-section, the width < twice the thickness, rolled or obtained by continuous casting', 'crude_steel'),
  ('72072015', 'Semi-finished products of iron or non-alloy steel, containing by weight >= 0,25% but < 0,6% carbon, of square or rectangular cross-section, the width < twice the thickness, rolled or obtained by continuous casting (excl. free-cutting steel)', 'crude_steel'),
  ('72072017', 'Semi-finished products of iron or non-alloy steel, containing by weight >= 0,6% carbon, of square or rectangular cross-section, the width < twice the thickness, rolled or obtained by continuous casting (excl. free-cutting steel)', 'crude_steel'),
  ('72072019', 'Semi-finished products of iron or non-alloy steel, containing by weight >= 0,25% carbon, of square or rectangular cross-section, the width < twice the thickness, forged', 'crude_steel'),
  ('72072032', 'Semi-finished products of iron or non-alloy steel, containing by weight >= 0,25 of carbon, of rectangular "other than square" cross-section, the width measuring >= twice the thickness, rolled or obtained by continuous casting', 'crude_steel'),
  ('72072039', 'Semi-finished products of iron or non-alloy steel, containing by weight >= 0,25% carbon, of rectangular "other than square" cross-section and the width >= twice the thickness, forged', 'crude_steel'),
  ('72072052', 'Semi-finished products of iron or non-alloy steel, containing by weight >= 0,25% carbon, of circular or polygonal cross-section, rolled or obtained by continuous casting', 'crude_steel'),
  ('72072059', 'Semi-finished products of iron or non-alloy steel, containing by weight >= 0,6% carbon, of circular or polygonal cross-section, forged', 'crude_steel'),
  ('72072080', 'Semi-finished products of iron or non-alloy steel, containing by weight >= 0,25% carbon (excl. those of square, rectangular, circular or polygonal cross-section)', 'crude_steel'),
  ('72081000', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, in coils, simply hot-rolled, not clad, plated or coated, with patterns in relief directly due to the rolling process', 'iron_steel_products'),
  ('72082500', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, in coils, simply hot-rolled, not clad, plated or coated, of a thickness of >= 4,75 mm, pickled, without patterns in relief', 'iron_steel_products'),
  ('72082600', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, in coils, simply hot-rolled, not clad, plated or coated, of a thickness of >= 3 mm but < 4,75 mm, pickled, without patterns in relief', 'iron_steel_products'),
  ('72082700', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, in coils, simply hot-rolled, not clad, plated or coated, of a thickness of < 3 mm, pickled, without patterns in relief', 'iron_steel_products'),
  ('72083600', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, in coils, simply hot-rolled, not clad, plated or coated, of a thickness of >= 10 mm, not pickled, without patterns in relief', 'iron_steel_products'),
  ('72083700', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, in coils, simply hot-rolled, not clad, plated or coated, of a thickness of >= 4,75 mm but < 10 mm, not pickled, without patterns in relief', 'iron_steel_products'),
  ('72083800', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, in coils, simply hot-rolled, not clad, plated or coated, of a thickness of >= 3 mm but < 4,75 mm, not pickled, without patterns in relief', 'iron_steel_products'),
  ('72083900', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, in coils, simply hot-rolled, not clad, plated or coated, of a thickness of < 3 mm, not pickled, without patterns in relief', 'iron_steel_products'),
  ('72084000', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, not in coils, simply hot-rolled, not clad, plated or coated, with patterns in relief directly due to the rolling process', 'iron_steel_products'),
  ('72085120', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, not in coils, simply hot-rolled, not clad, plated or coated, of a thickness of > 15 mm, without patterns in relief', 'iron_steel_products'),
  ('72085191', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 2.050 mm, not in coils, simply hot-rolled, not clad, plated or coated, of a thickness of > 10 mm but <= 15 mm, without patterns in relief (excl. "wide flats")', 'iron_steel_products'),
  ('72085198', 'Flat-rolled products of iron or non-alloy steel, of a width of < 2.050 mm but >= 600 mm, not in coils, simply hot-rolled, not clad, plated or coated, of a thickness of > 10 mm but <= 15 mm, without patterns in relief', 'iron_steel_products'),
  ('72085210', 'Flat-rolled products of iron or non-alloy steel, of a width of <= 1.250 mm, not in coils, simply hot-rolled on four faces or in a closed box pass, not clad, plated or coated, of a thickness of >= 4,75 mm but <= 10 mm, without patterns in relief', 'iron_steel_products'),
  ('72085291', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 2.050 mm, not in coils, simply hot-rolled, not clad, plated or coated, of a thickness of >= 4,75 mm but <= 10 mm, without patterns in relief', 'iron_steel_products'),
  ('72085299', 'Flat-rolled products of iron or non-alloy steel, of a width of < 2.050 mm but >= 600 mm, not in coils, simply hot-rolled, not clad, plated or coated, of a thickness of >= 4,75 mm but <= 10 mm, without patterns in relief (excl. rolled on four faces or in a closed bow pass of a width <= 1.250 mm)', 'iron_steel_products'),
  ('72085310', 'Flat-rolled products of iron or non-alloy steel, of a width of <= 1.250 mm, not in coils, simply hot-rolled on four faces or in a closed box pass, not clad, plated or coated, of a thickness of >= 4 mm but < 4,75 mm, without patterns in relief', 'iron_steel_products'),
  ('72085390', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, not in coils, simply hot-rolled, not clad, plated or coated, of a thickness of >= 3 mm but < 4,75 mm, without patterns in relief (excl. rolled on four faces or in a closed bow pass of a width <= 1.250 mm and of a thickness of >= 4 mm)', 'iron_steel_products'),
  ('72085400', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, not in coils, simply hot-rolled, not clad, plated or coated, of a thickness of < 3 mm, without patterns in relief', 'iron_steel_products'),
  ('72089020', 'Flat-rolled products of iron or steel, of a width >= 600 mm, hot-rolled and further worked, but not clad, plated or coated, perforated', 'iron_steel_products'),
  ('72089080', 'Flat-rolled products of iron or steel, of a width >= 600 mm, hot-rolled and further worked, but not clad, plated or coated, non-perforated', 'iron_steel_products'),
  ('72091500', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, in coils, simply cold-rolled "cold-reduced", not clad, plated or coated, of a thickness of >= 3 mm', 'iron_steel_products'),
  ('72091610', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, in coils, simply cold-rolled "cold-reduced", of a thickness of > 1 mm but < 3 mm "electrical"', 'iron_steel_products'),
  ('72091690', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, in coils, simply cold-rolled "cold-reduced", of a thickness of > 1 mm but < 3 mm "electrical"', 'iron_steel_products'),
  ('72091710', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, in coils, simply cold-rolled "cold-reduced", of a thickness of >= 0,5 mm but <= 1 mm "electrical"', 'iron_steel_products'),
  ('72091790', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, in coils, simply cold-rolled "cold-reduced", not clad, plated or coated, of a thickness of >= 0,5 mm but <= 1 mm (excl. electrical)', 'iron_steel_products'),
  ('72091810', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, in coils, simply cold-rolled "cold-reduced", of a thickness of < 0,5 mm "electrical"', 'iron_steel_products'),
  ('72091891', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, in coils, simply cold-rolled "cold-reduced", not clad, plated or coated, of a thickness of >= 0,35 mm but < 0,5 mm (excl. electrical)', 'iron_steel_products'),
  ('72091899', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, in coils, simply cold-rolled "cold-reduced", not clad, plated or coated, of a thickness of < 0,35 mm (excl. electrical)', 'iron_steel_products'),
  ('72092500', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, not in coils, simply cold-rolled "cold-reduced", not clad, plated or coated, of a thickness of >= 3 mm', 'iron_steel_products'),
  ('72092610', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, not in coils, simply cold-rolled "cold-reduced", of a thickness of > 1 mm but < 3 mm "electrical"', 'iron_steel_products'),
  ('72092690', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, not in coils, simply cold-rolled "cold-reduced", not clad, plated or coated, of a thickness of > 1 mm but < 3 mm (excl. electrical)', 'iron_steel_products'),
  ('72092710', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, not in coils, simply cold-rolled "cold-reduced", of a thickness of >= 0,5 mm but <= 1 mm "electrical"', 'iron_steel_products'),
  ('72092790', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, not in coils, simply cold-rolled "cold-reduced", not clad, plated or coated, of a thickness of >= 0,5 mm but <= 1 mm (excl. electrical)', 'iron_steel_products'),
  ('72092810', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, not in coils, simply cold-rolled "cold-reduced", of a thickness of < 0,5 mm "electrical"', 'iron_steel_products'),
  ('72092890', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, not in coils, simply cold-rolled "cold-reduced", not clad, plated or coated, of a thickness of < 0,5 mm (excl. electrical)', 'iron_steel_products'),
  ('72099020', 'Flat-rolled products of iron or steel, of a width of >= 600 mm, cold-rolled "cold-reduced" and further worked, but not clad, plated or coated, perforated', 'iron_steel_products'),
  ('72099080', 'Flat-rolled products of iron or steel, of a width of >= 600 mm, cold-rolled "cold-reduced" and further worked, but not clad, plated or coated, non-perforated', 'iron_steel_products'),
  ('72101100', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, hot-rolled or cold-rolled "cold-reduced", tinned, of a thickness of >= 0,5 mm', 'iron_steel_products'),
  ('72101220', 'Tinplate of iron or non-alloy steel, of a width of >= 600 mm and of a thickness of < 0,5 mm, tinned [coated with a layer of metal containing, by weight,  >= 97% of tin], not further worked than surface-treated', 'iron_steel_products'),
  ('72101280', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, hot-rolled or cold-rolled "cold-reduced", plated or coated with tin, of a thickness of < 0,5 mm (excl. tinplate)', 'iron_steel_products'),
  ('72102000', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, hot-rolled or cold-rolled "cold-reduced", plated or coated with lead, incl. terne-plate', 'iron_steel_products'),
  ('72103000', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, hot-rolled or cold-rolled "cold-reduced", electrolytically plated or coated with zinc', 'iron_steel_products'),
  ('72104100', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, hot-rolled or cold-rolled "cold-reduced", corrugated, plated or coated with zinc (excl. electrolytically plated or coated with zinc)', 'iron_steel_products'),
  ('72104900', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, hot-rolled or cold-rolled "cold-reduced", not corrugated, plated or coated with zinc (excl. electrolytically plated or coated with zinc)', 'iron_steel_products'),
  ('72105000', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, hot-rolled or cold-rolled "cold-reduced", plated or coated with chromium oxides or with chromium and chromium oxides', 'iron_steel_products'),
  ('72106100', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, hot-rolled or cold-rolled "cold-reduced", plated or coated with aluminium-zinc alloys', 'iron_steel_products'),
  ('72106900', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, hot-rolled or cold-rolled "cold-reduced", plated or coated with aluminium (excl. products plated or coated with aluminium-zinc alloys)', 'iron_steel_products'),
  ('72107010', 'Tinplate of a width of >= 600 mm and of a thickness of < 0,5 mm, tinned [coated with a layer of metal containing, by weight,  >= 97% of tin], not further worked than varnished, and flat products plated or coated with chromium oxides or with chromium and chromium oxides, of iron or non-alloy steel, of a width of >= 600 mm, hot-rolled or cold-rolled "cold-reduced", varnished', 'iron_steel_products'),
  ('72107080', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, hot-rolled or cold-rolled "cold-reduced", painted, varnished or plastic coated (excl. tinplate and products electrolytically plated or coated with chrome, varnished)', 'iron_steel_products'),
  ('72109030', 'Flat-rolled products of iron or non-alloy steel, of a width of >= 600 mm, hot-rolled or cold-rolled "cold-reduced", clad', 'iron_steel_products'),
  ('72109040', 'Flat-rolled products of iron or non-alloy steel, tinned and printed, of a width of >= 600 mm, hot-rolled or cold-rolled "cold-reduced"', 'iron_steel_products'),
  ('72109080', 'Flat-rolled products of iron or non-alloy steel, hot-rolled or cold-rolled "cold-reduced", of a width of >= 600 mm, plated or coated (excl. plated or coated with thin, lead "incl. terne-plate", zinc, aluminium, chromium, chromium oxides, plastics, platinum, painted or varnished, clad and tinned and printed)', 'iron_steel_products'),
  ('72111300', 'Flat-rolled products of iron or non-alloy steel, simply hot-rolled on four faces or in a closed box pass, not clad, plated or coated, of a width of > 150 mm but < 600 mm and a thickness of >= 4 mm, not in coils, without patterns in relief, commonly known as "wide flats"', 'iron_steel_products'),
  ('72111400', 'Flat-rolled products of iron or non-alloy steel, of a width < 600 mm, not further worked than hot-rolled, not clad, plated or coated, of a thickness of >= 4,75 mm (excl. "wide flats")', 'iron_steel_products'),
  ('72111900', 'Flat-rolled products of iron or non-alloy steel, of a width < 600 mm, simply hot-rolled, not clad, plated or coated, of a thickness < 4,75 mm (excl. "wide flats")', 'iron_steel_products'),
  ('72112320', 'Flat-rolled products of iron or non-alloy steel, of a width of < 600 mm, simply cold-rolled "cold-reduced", not clad, plated or coated, containing by weight < 0,25% of carbon "electrical"', 'iron_steel_products'),
  ('72112330', 'Flat-rolled products of iron or non-alloy steel, of a width of < 600 mm and of a thickness of >= 0,35 mm, simply cold-rolled "cold-reduced", not clad, plated or coated, containing by weight < 0,25% of carbon (excl. electrical plate)', 'iron_steel_products'),
  ('72112380', 'Flat-rolled products of iron or non-alloy steel, of a width of < 600 mm and of a thickness of < 0,35 mm, simply cold-rolled "cold-reduced", not clad, plated or coated, containing by weight < 0,25% of carbon (excl. electrical plate)', 'iron_steel_products'),
  ('72112900', 'Flat-rolled products of iron or non-alloy steel, of a width of < 600 mm, simply cold-rolled "cold-reduced", not clad, plated or coated, containing by weight >= 0,25% of carbon', 'iron_steel_products'),
  ('72119020', 'Flat-rolled products of iron or non-alloy steel, of a width of < 600 mm, hot-rolled or cold-rolled "cold-reduced" and further worked, but not clad, plated or coated, perforated', 'iron_steel_products'),
  ('72119080', 'Flat-rolled products of iron or non-alloy steel, of a width of < 600 mm, hot-rolled or cold-rolled "cold-reduced" and further worked, but not clad, plated or coatednon-perforated', 'iron_steel_products'),
  ('72121010', 'Tinplate of iron or non-alloy steel, of a width of < 600 mm and of a thickness of < 0,5 mm, tinned [coated with a layer of metal containing, by weight,  >= 97% of tin], not further worked than surface-treated', 'iron_steel_products'),
  ('72121090', 'Flat-rolled products of iron or non-alloy steel, hot-rolled or cold-rolled "cold-reduced", of a width of < 600 mm, tinned (excl. tinplate, not further worked than surface-treated)', 'iron_steel_products'),
  ('72122000', 'Flat-rolled products of iron or non-alloy steel, of a width of < 600 mm, hot-rolled or cold-rolled "cold-reduced", electrolytically plated or coated with zinc', 'iron_steel_products'),
  ('72123000', 'Flat-rolled products of iron or non-alloy steel, of a width of < 600 mm, hot-rolled or cold-rolled "cold-reduced", tinned (excl. electrolytically plated or coated with zinc)', 'iron_steel_products'),
  ('72124020', 'Tinplate of a width of < 600 mm and of a thickness of < 0,5 mm, tinned [coated with a layer of metal containing, by weight,  >= 97% of tin], not further worked than varnished, and flat products plated or coated with chromium oxides or with chromium and chromium oxides, of iron or non-alloy steel, of a width of < 600 mm, hot-rolled or cold-rolled "cold-reduced", varnished', 'iron_steel_products'),
  ('72124080', 'Flat-rolled products of iron or non-alloy steel, of a width of < 600 mm, hot-rolled or cold-rolled "cold-reduced", painted, varnished or plastic coated (excl. tinplate, not further worked than varnished, and products plated or coated with chromium oxides or with chromium and chromium oxides, varnished)', 'iron_steel_products'),
  ('72125020', 'Flat-rolled products of iron or non-alloy steel, of a width of < 600 mm, hot-rolled or cold-rolled "cold-reduced", plated or coated with chromium oxides or with chromium and chromium oxides (excl. varnished)', 'iron_steel_products'),
  ('72125030', 'Flat-rolled products of iron or non-alloy steel, of a width of < 600 mm, hot-rolled or cold-rolled "cold-reduced", plated or coated with chromium or nickel', 'iron_steel_products'),
  ('72125040', 'Flat-rolled products of iron or non-alloy steel, of a width of < 600 mm, hot-rolled or cold-rolled "cold-reduced", plated or coated with copper', 'iron_steel_products'),
  ('72125061', 'Flat-rolled products of iron or non-alloy steel, of a width of < 600 mm, hot-rolled or cold-rolled "cold-reduced", plated or coated with aluminium-zinc alloys', 'iron_steel_products'),
  ('72125069', 'Flat-rolled products of iron or non-alloy steel, of a width of < 600 mm, hot-rolled or cold-rolled "cold-reduced", plated or coated with aluminium (excl. products plated or coated with aluminium-zinc alloys)', 'iron_steel_products'),
  ('72125090', 'Flat-rolled products of iron or non-alloy steel, of a width of < 600 mm, hot-rolled or cold-rolled "cold-reduced", clad (excl. products plated or coated with tin or zinc, copper, with chromium oxides or with chromium and chromium oxides, chromium, nickel or aluminium, painted or varnished, and plastic-coated)', 'iron_steel_products'),
  ('72126000', 'Flat-rolled products of iron or non-alloy steel, of a width of < 600 mm, hot-rolled or cold-rolled "cold-reduced", clad', 'iron_steel_products'),
  ('72131000', 'Bars and rods, hot-rolled, in irregularly wound coils of iron or non-alloy steel, with indentations, ribs, grooves or other deformations produced during the rolling process', 'iron_steel_products'),
  ('72132000', 'Bars and rods, hot-rolled, in irregularly wound coils, of non-alloy free-cutting steel (excl. bars and rods containing indentations, ribs, grooves or other deformations produced during the rolling process)', 'iron_steel_products'),
  ('72139110', 'Bars and rods, hot-rolled, of the type used for concrete reinforcement, smooth, of iron or non-alloy steel, in irregularly wound coils, of circular cross-section measuring < 14 mm in diameter', 'iron_steel_products'),
  ('72139120', 'Bars and rods, hot-rolled, of the type used for tyre cord, smooth, of iron or non-alloy steel, in irregularly wound coils', 'iron_steel_products'),
  ('72139141', 'Bars and rods, hot-rolled, of iron or non-alloy steel, in irregularly wound coils, containing by weight <= 0,06% of carbon, of circular cross-section measuring < 14 mm in diameter (excl. free-cutting steel, bars and rods, hot-rolled, for concrete reinforcement and tyre cord, and bars and rods, hot-rolled, containing indentations, ribs, grooves or other deformations produced during the rolling process)', 'iron_steel_products'),
  ('72139149', 'Bars and rods, hot-rolled, of iron or non-alloy steel, in irregularly wound coils, containing by weight > 0,06% and < 0,25% of carbon, of circular cross-section, measuring < 14 mm in diameter (excl. of free-cutting steel, bars and rods, hot-rolled, for concrete reinforcement and tyre cord and bars and rods, hot-rolled, containing indentations, ribs, grooves or other deformations produced during the rolling process)', 'iron_steel_products'),
  ('72139170', 'Bars and rods, hot-rolled, in irregularly wound coils, of iron or non-alloy steel, containing by weight >= 0,25% but <= 0,75% carbon, of circular cross-section measuring < 14 mm in diameter (excl. of free-cutting steel, and bars and rods, smooth, for concrete reinforcement and tyre cord, and bars and rods with indentations, ribs, grooves or other deformations produced during the rolling process)', 'iron_steel_products'),
  ('72139190', 'Bars and rods, hot-rolled, of iron or non-alloy steel, in irregularly wound coils, containing by weight > 0,75% of carbon, of circular cross-section measuring < 14 mm in diameter (excl. of free-cutting steel, bars and rods, smooth, for tyre cord and bars and rods with indentations, ribs, grooves and other deformations produced during the rolling process)', 'iron_steel_products'),
  ('72139910', 'Bars and rods, of iron or non-alloy steel, hot-rolled, in irregularly wound coils, containing by weight < 0,25% carbon (excl. products of circular cross-section measuring < 14 mm in diameter, bars and rods of free-cutting steel, and bars and rods with indentations, ribs, grooves or other deformations produced during the rolling process)', 'iron_steel_products'),
  ('72139990', 'Bars and rods, hot-rolled, in irregularly wound coils, of iron or non-alloy steel, containing by weight >= 0,25% carbon (excl. products of circular cross-section measuring < 14 mm diameter, bars and rods of free-cutting steel, and bars and rods with indentations, ribs, grooves or other deformations produced during the rolling process)', 'iron_steel_products'),
  ('72141000', 'Bars and rods, of iron or non-alloy steel, not further worked than forged (excl. in irregularly wound coils)', 'iron_steel_products'),
  ('72142000', 'Bars and rods, of iron or non-alloy steel, with indentations, ribs, groves or other deformations produced during the rolling process', 'iron_steel_products'),
  ('72143000', 'Bars and rods, of non-alloy free-cutting steel, not further worked than hot-rolled, hot-drawn or hot-extruded (excl. containing indentations, ribs, grooves or other deformations produced during the rolling process or twisted after rolling)', 'iron_steel_products'),
  ('72149110', 'Bars and rods of iron or non-alloy steel, not further worked than hot-rolled, hot-drawn or hot-extruded, containing by weight < 0,25% of carbon, of rectangular "other than square" cross-section (excl. those with indentations, ribs, grooves or other deformations produced during the rolling process, bars and rods twisted after rolling, and free-cutting steel)', 'iron_steel_products'),
  ('72149190', 'Other bars and rods of iron or non-alloy steel, only hot-rolled, only hot-drawn or only hot-extruded, containing by weight >= 0,25% of carbon, of rectangular "other than square" cross-section (excl. those with indentations, ribs, grooves or other deformations produced during the rolling process, bars and rods twisted after rolling, and free-cutting steel)', 'iron_steel_products'),
  ('72149910', 'Bars and rods of the type used for concrete reinforcement, smooth, of iron or non-alloy steel, only hot-rolled, only hot-drawn or only hot-extruded, containing < 0,25% of carbon, of square cross-section or of a cross-section other than rectangular', 'iron_steel_products'),
  ('72149931', 'Bars and rods of iron or non-alloy steel, only hot-rolled, hot-drawn or hot-extruded, containing < 0,25% of carbon, of circular cross-section, of a maximum diameter of >= 80 mm (other than of free-cutting steel, smooth bars and rods, for reinfoced concrete, or bars and rods containing indentations, ribs, grooves or other deformations produced during the rolling process, or wound after rolling)', 'iron_steel_products'),
  ('72149939', 'Bars and rods of iron or non-alloy steel, only hot-rolled, hot-drawn or hot-extruded, containing < 0,25% of carbon, of circular cross-section of a maximum diameter of < 80 mm (other than of free-cutting steel, smooth bars and rods, for reinforced concrete, or bars and rods containing indentations, ribs, grooves or other deformations produced during the rolling process, or wound after rolling)', 'iron_steel_products'),
  ('72149950', 'Bars and rods of iron or non-alloy steel, only hot-rolled, hot-drawn or hot-extruded, containing by weight < 0,25% of carbon, of square cross-section or of a cross-section other than square or circular (other than of free-cutting steel, smooth bars and rods, for reinforced concrete, or bars and rods containing indentations, ribs, grooves or other deformations produced during the rolling process, or wound after rolling)', 'iron_steel_products'),
  ('72149971', 'Bars and rods of iron or non-alloy steel, only hot-rolled, only hot-drawn or only hot-extruded, containing by weight >= 0,25% carbon, of circular cross-section measuring >= 80 mm in diameter (excl. bars and rods with indentations, ribs, grooves or other deformations produced during the rolling process, twisted after rolling, and of free-cutting steel)', 'iron_steel_products'),
  ('72149979', 'Bars and rods of iron or non-alloy steel, only hot-rolled, only hot-drawn or only hot-extruded, containing by weight >= 0,25% carbon, of circular cross-section measuring < 80 mm in diameter (excl. bars and rods with indentations, ribs, grooves or other deformations produced during the rolling process, twisted after rolling, and of free-cutting steel)', 'iron_steel_products'),
  ('72149995', 'Bars and rods of iron or non-alloy steel, only hot-rolled, only hot-drawn or only hot-extruded, containing by weight >= 0,25% carbon, of square or of other than rectangular or circular cross-section (excl. indentations, ribs, grooves or other deformations produced during the rolling process, twisted fter rolling, and of free-cutting steel)', 'iron_steel_products'),
  ('72151000', 'Bars and rods, of non-alloy free-cutting steel, not further worked than cold-formed or cold-finished', 'iron_steel_products'),
  ('72155011', 'Other bars and rods of iron or non-alloy steel, not further worked than cold-formed or cold-finished, containing by weight < 0,25% of carbon of rectangular "other than square" cross-section (excl. those of free-cutting steel)', 'iron_steel_products'),
  ('72155019', 'Other bars and rods of iron or non-alloy steel, not further worked than cold-formed or cold-finished, containing by weight < 0,25% of carbon, of square or other than rectangular cross-section (excl. those of free-cutting steel)', 'iron_steel_products'),
  ('72155080', 'Other bars and rods of iron or non-alloy steel, not further worked than cold-formed or cold-finished, containing by weight >= 0,25% of carbon (excl. those of free-cutting steel)', 'iron_steel_products'),
  ('72159000', 'Bars or rods, of iron or non-alloy steel, cold-formed or cold-finished and further worked or hot-formed and further worked, n.e.s.', 'iron_steel_products'),
  ('72161000', 'U, I or H sections of iron or non-alloy steel, not further worked than hot-rolled, hot-drawn or extruded, of a height of < 80 mm', 'iron_steel_products'),
  ('72162100', 'L sections of iron or non-alloy steel, not further worked than hot-rolled, hot-drawn or extruded, of a height of < 80 mm', 'iron_steel_products'),
  ('72162200', 'T sections of iron or non-alloy steel, not further worked than hot-rolled, hot-drawn or extruded, of a height of < 80 mm', 'iron_steel_products'),
  ('72163110', 'U sections of iron or non-alloy steel, simply hot-rolled, hot-drawn or extruded, of a height >= 80 mm but <= 220 mm', 'iron_steel_products'),
  ('72163190', 'U sections of iron or non-alloy steel, simply hot-rolled, hot-drawn or extruded, of a height > 220 mm', 'iron_steel_products'),
  ('72163211', 'I sections with parallel flange faces, of iron or non-alloy steel, simply hot-rolled, hot-drawn or extruded, of a height >= 80 mm but <= 220 mm', 'iron_steel_products'),
  ('72163219', 'I sections of iron or non-alloy steel, simply hot-rolled, hot-drawn or extruded, of a height >= 80 mm but <= 220 mm (excl. 7216.32.11)', 'iron_steel_products'),
  ('72163291', 'I sections with parallel flange faces, of iron or non-alloy steel, simply hot-rolled, hot-drawn or extruded, of a height > 220 mm', 'iron_steel_products'),
  ('72163299', 'I sections of iron or non-alloy steel, simply hot-rolled, hot-drawn or extruded, of a height > 220 mm (excl. 7216.32.91)', 'iron_steel_products'),
  ('72163310', 'H sections of iron or non-alloy steel, simply hot-rolled, hot-drawn or extruded, of a height >= 80 mm but <= 180 mm', 'iron_steel_products'),
  ('72163390', 'H sections of iron or non-alloy steel, simply hot-rolled, hot-drawn or extruded, of a height > 180 mm', 'iron_steel_products'),
  ('72164010', 'L sections of iron or non-alloy steel, not further worked than hot-rolled, hot-drawn or extruded, of a height of >= 80 mm', 'iron_steel_products'),
  ('72164090', 'T sections of iron or non-alloy steel, not further worked than hot-rolled, hot-drawn or extruded, of a height of >= 80 mm', 'iron_steel_products'),
  ('72165010', 'Sections of iron or non-alloy steel, not further worked than hot-rolled, hot-drawn or hot-extruded, with a cross-section which is capable of being enclosed in a square the side of which is <= 80 mm (excl. U, I, H, L or T sections)', 'iron_steel_products'),
  ('72165091', 'Bulb sections "bulb flat", only hot-rolled, hot-drawn or hot-extruded', 'iron_steel_products'),
  ('72165099', 'Profile of iron or non-alloy steel, only hot-rolled, hot-drawn or hot-extruded (other than with a cross-section which is capable of being enclosed in a square the side of which is <= 80 mm, and U-, I-, H-, L- or T-sections and ribbed sections [ribbed steel])', 'iron_steel_products'),
  ('72166110', 'c, l, u, z, omega or open-ended sections of iron or non-alloy steel, simply cold-formed or cold-finished, obtained from flat-rolled products', 'iron_steel_products'),
  ('72166190', 'Angles, shapes and sections (other than c, l, u, z, omega or open-ended sections) of iron or non-alloy steel, simply cold-formed or cold-finished, obtained from flat-rolled products', 'iron_steel_products'),
  ('72166900', 'Angles, shapes and sections, of iron or non-alloy steel, not further worked than cold-formed or cold-finished (excl. profiled sheet)', 'iron_steel_products'),
  ('72169110', 'Sheets sheets of iron or non-alloy steel, cold-formed or cold finished, profiled "ribbed"', 'iron_steel_products'),
  ('72169180', 'Angles, shapes and sections, of iron or non-alloy steel, cold-formed or cold-finished from flat-rolled products and further worked (excl. profiled sheet)', 'iron_steel_products'),
  ('72169900', 'Angles, shapes and sections, of iron or non-alloy steel, cold-formed or cold-finished and further worked, or hot-forged, or hot-formed by other means and further worked, n.e.s. (excl. from flat-rolled products)', 'iron_steel_products'),
  ('72171010', 'Wire of iron or non-alloy steel, in coils, containing by weight < 0,25% carbon, not plated or coated, whether or not polished, with a maximum cross-sectional dimension of < 0,8 mm', 'iron_steel_products'),
  ('72171031', 'Wire of iron or non-alloy steel, in coils, containing by weight < 0,25% carbon, with indentations, ribs, grooves or other deformations produced during the rolling process, not plated or coated, with a maximum cross-sectional dimension of >= 0,8 mm', 'iron_steel_products'),
  ('72171039', 'Wire of iron or non-alloy steel, in coils, containing by weight < 0,25% carbon, not plated or coated, with a maximum cross-sectional dimension of >= 0,8 mm (without indentations, ribs, grooves or other deformations produced during the rolling process)', 'iron_steel_products'),
  ('72171050', 'Wire of iron or non-alloy steel, in coils, containing by weight >= 0,25% but < 0,6% carbon, not plated or coated, whether or not polished (excl. hot-rolled bars and rods)', 'iron_steel_products'),
  ('72171090', 'Wire of iron or non-alloy steel, in coils, containing by weight >= 0,6% carbon, not plated or coated, whether or not polished (excl. hot-rolled bars and rods)', 'iron_steel_products'),
  ('72172010', 'Wire of iron or non-alloy steel, in coils, containing by weight < 0,25% carbon, plated or coated with zinc, with a maximum cross-sectional dimension of < 0,8 mm', 'iron_steel_products'),
  ('72172030', 'Wire of iron or non-alloy steel, in coils, containing by weight < 0,25% carbon, plated or coated with zinc, with a maximum cross-sectional dimension of < 0,8 mm (excl. bars and rods)', 'iron_steel_products'),
  ('72172050', 'Wire of iron or non-alloy steel, in coils, containing by weight >= 0,25% but < 0,6% carbon, plated or coated with zinc (excl. bars and rods)', 'iron_steel_products'),
  ('72172090', 'Wire of iron or non-alloy steel, in coils, containing by weight >= 0,6% carbon, plated or coated with zinc (excl. bars and rods)', 'iron_steel_products'),
  ('72173041', 'Wire of iron or non-alloy steel, in coils, containing by weight < 0,25% carbon, copper-coated (excl. bars and rods)', 'iron_steel_products'),
  ('72173049', 'Wire of iron or non-alloy steel, in coils, containing by weight < 0,25% carbon, plated or coated with base metals (excl. products plated or coated with zinc or copper and bars and rods)', 'iron_steel_products'),
  ('72173050', 'Wire of iron or non-alloy steel, in coils, containing by weight >= 0,25% but < 0,6% carbon, plated or coated with base metals (excl. products plated or coated with zinc, and bars and rods)', 'iron_steel_products'),
  ('72173090', 'Wire of iron or non-alloy steel, in coils, containing by weight >= 0,6% carbon, plated or coated with base metals (excl. products plated or coated with zinc, and bars and rods)', 'iron_steel_products'),
  ('72179020', 'Wire of iron or non-alloy steel, in coils, containing by weight < 0,25% carbon, plated or coated (excl. products plated or coated with base metals and bars and rods)', 'iron_steel_products'),
  ('72179050', 'Wire of iron or non-alloy steel, in coils, containing by weight >= 0,25% but < 0,6% carbon, plated or coated (excl. products plated or coated with with base metals, and bars and rods)', 'iron_steel_products'),
  ('72179090', 'Wire of iron or non-alloy steel, in coils, containing by weight >= 0,6% carbon, plated or coated (excl. products plated or coated with base metals, and bars and rods)', 'iron_steel_products'),
  ('72181000', 'Steel, stainless, in ingots and other primary forms (excl. waste and scrap in ingot form, and products obtained by continuous casting)', 'crude_steel'),
  ('72189110', 'Semi-finished products of stainless steel, of rectangular "other than square" cross-section, containing by weight >= 2,5% nickel', 'crude_steel'),
  ('72189180', 'Semi-finished products of stainless steel, of rectangular "other than square" cross-section, containing by weight < 2,5 nickel', 'crude_steel'),
  ('72189911', 'Semi-finished products of stainless steel, of square cross-section, rolled or obtained by continuous casting', 'crude_steel'),
  ('72189919', 'Semi-finished products of stainless steel, of square cross-section, forged', 'crude_steel'),
  ('72189920', 'Semi-finished products of stainless steel, of circular cross-section or of cross-section other than square or rectangular, rolled or obtained by continuous casting', 'crude_steel'),
  ('72189980', 'Semi-finished products of stainless steel, forged (excl. products of square or rectangular cross-section)', 'crude_steel'),
  ('72191100', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than hot-rolled, in coils, of a thickness of > 10 mm', 'iron_steel_products'),
  ('72191210', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than hot-rolled, in coils, of a thickness of >= 4,75 mm but <= 10 mm, containing by weight >= 2,5 nickel', 'iron_steel_products'),
  ('72191290', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than hot-rolled, in coils, of a thickness of >= 4,75 mm but <= 10 mm, containing by weight < 2,5 nickel', 'iron_steel_products'),
  ('72191310', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than hot-rolled, in coils, of a thickness of >= 3 mm but <= 4,75 mm, containing by weight >= 2,5 nickel', 'iron_steel_products'),
  ('72191390', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than hot-rolled, in coils, of a thickness of >= 3 mm but <= 4,75 mm, containing by weight < 2,5 nickel', 'iron_steel_products'),
  ('72191410', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than hot-rolled, in coils, of a thickness of < 3 mm, containing by weight >= 2,5 nickel', 'iron_steel_products'),
  ('72191490', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than hot-rolled, in coils, of a thickness of < 3 mm, containing by weight < 2,5 nickel', 'iron_steel_products'),
  ('72192110', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than hot-rolled, not in coils, of a thickness of > 10 mm, containing by weight >= 2,5 nickel', 'iron_steel_products'),
  ('72192190', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than hot-rolled, not in coils, of a thickness of > 10 mm, containing by weight < 2,5 nickel', 'iron_steel_products'),
  ('72192210', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than hot-rolled, not in coils, of a thickness of >= 4,75 mm but <= 10 mm, containing by weight >= 2,5% nickel', 'iron_steel_products'),
  ('72192290', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than hot-rolled, not in coils, of a thickness of >= 4,75 mm but <= 10 mm, containing by weight < 2,5% nickel', 'iron_steel_products'),
  ('72192300', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than hot-rolled, not in coils, of a thickness of >= 3 mm and < 4,75 mm', 'iron_steel_products'),
  ('72192400', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than hot-rolled, not in coils, of a thickness of < 3 mm', 'iron_steel_products'),
  ('72193100', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than cold-rolled "cold-reduced", of a thickness of >= 4,75 mm', 'iron_steel_products'),
  ('72193210', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than cold-rolled "cold-reduced", of a thickness of >= 3 mm but <= 4,75 mm, containing by weight >= 2,5% nickel', 'iron_steel_products'),
  ('72193290', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than cold-rolled "cold-reduced", of a thickness of >= 3 mm but <= 4,75 mm, containing by weight < 2,5% nickel', 'iron_steel_products'),
  ('72193310', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than cold-rolled "cold-reduced", of a thickness of > 1 mm but < 3 mm, containing by weight >= 2,5% nickel', 'iron_steel_products'),
  ('72193390', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than cold-rolled "cold-reduced", of a thickness of > 1 mm but < 3 mm, containing by weight < 2,5% nickel', 'iron_steel_products'),
  ('72193410', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than cold-rolled "cold-reduced", of a thickness of >= 0,5 mm but <= 1 mm, containing by weight >= 2,5% nickel', 'iron_steel_products'),
  ('72193490', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than cold-rolled "cold-reduced", of a thickness of >= 0,5 mm but <= 1 mm, containing by weight < 2,5% nickel', 'iron_steel_products'),
  ('72193510', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than cold-rolled "cold-reduced", of a thickness of < 0,5 mm, containing by weight >= 2,5% nickel', 'iron_steel_products'),
  ('72193590', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, not further worked than cold-rolled "cold-reduced", of a thickness of < 0,5 mm, containing by weight < 2,5% nickel', 'iron_steel_products'),
  ('72199020', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, hot-rolled or cold-rolled "cold-reduced" and further worked, perforated', 'iron_steel_products'),
  ('72199080', 'Flat-rolled products of stainless steel, of a width of >= 600 mm, hot-rolled or cold-rolled "cold-reduced" and further worked, non-perforated', 'iron_steel_products'),
  ('72201100', 'Flat-rolled products of stainless steel, of a width of < 600 mm, not further worked than hot-rolled, of a thickness of >= 4,75 mm', 'iron_steel_products'),
  ('72201200', 'Flat-rolled products of stainless steel, of a width of < 600 mm, not further worked than hot-rolled, of a thickness of < 4,75 mm', 'iron_steel_products'),
  ('72202021', 'Flat-rolled products of stainless steel, of a width of < 600 mm, not further worked than cold-rolled "cold-reduced", of a thickness of >= 3 mm and containing by weight >= 2,5% nickel', 'iron_steel_products'),
  ('72202029', 'Flat-rolled products of stainless steel, of a width of < 600 mm, not further worked than cold-rolled "cold-reduced", of a thickness of >= 3 mm and containing by weight < 2,5% nickel', 'iron_steel_products'),
  ('72202041', 'Flat-rolled products of stainless steel, of a width of < 600 mm, not further worked than cold-rolled "cold-reduced", of a thickness of > 0,35 mm but < 3 mm, and containing by weight >= 2,5% nickel', 'iron_steel_products'),
  ('72202049', 'Flat-rolled products of stainless steel, of a width of < 600 mm, not further worked than cold-rolled "cold-reduced", of a thickness of > 0,35 mm but < 3 mm, and containing by weight < 2,5% nickel', 'iron_steel_products'),
  ('72202081', 'Flat-rolled products of stainless steel, of a width of < 600 mm, not further worked than cold-rolled "cold-reduced", of a thickness of <= 0,35 mm and containing by weight >= 2,5% nickel', 'iron_steel_products'),
  ('72202089', 'Flat-rolled products of stainless steel, of a width of < 600 mm, not further worked than cold-rolled "cold-reduced", of a thickness of <= 0,35 mm and containing by weight < 2,5% nickel', 'iron_steel_products'),
  ('72209020', 'Flat-rolled products of stainless steel, of a width of < 600 mm, hot-rolled or cold-rolled "cold-reduced" and further worked, perforated', 'iron_steel_products'),
  ('72209080', 'Flat-rolled products of stainless steel, of a width of < 600 mm, hot-rolled or cold-rolled "cold-reduced" and further worked, non-perforated', 'iron_steel_products'),
  ('72210010', 'Bars and rods of stainless steel, hot-rolled, in irregularly wound coils, containing by weight >= 2,5% nickel', 'iron_steel_products'),
  ('72210090', 'Bars and rods of stainless steel, hot-rolled, in irregularly wound coils, containing by weight < 2,5% nickel', 'iron_steel_products'),
  ('72221111', 'Bars and rods of stainless steel, not further worked than hot-rolled, hot-drawn or extruded, of circular cross-section of a diameter of >= 800 mm, containing by weight >= 2,5% nickel', 'iron_steel_products'),
  ('72221119', 'Bars and rods of stainless steel, not further worked than hot-rolled, hot-drawn or extruded, of circular cross-section of a diameter of >= 800 mm, containing by weight < 2,5% nickel', 'iron_steel_products'),
  ('72221181', 'Bars and rods of stainless steel, not further worked than hot-rolled, hot-drawn or extruded, of circular cross-section measuring < 80 mm and containing by weight >= 2,5% nickel', 'iron_steel_products'),
  ('72221189', 'Bars and rods of stainless steel, not further worked than hot-rolled, hot-drawn or extruded, of circular cross-section measuring < 80 mm and containing by weight < 2,5% nickel', 'iron_steel_products'),
  ('72221910', 'Bars and rods of stainless steel, not further worked than hot-rolled, hot-drawn or extruded, containing by weight >= 2,5% nickel (excl. such products of circular cross-section)', 'iron_steel_products'),
  ('72221990', 'Bars and rods of stainless steel, not further worked than hot-rolled, hot-drawn or extruded, containing by weight < 2,5% nickel (excl. such products of circular cross-section)', 'iron_steel_products'),
  ('72222011', 'Bars and rods of stainless steel, of circular cross-section of a diameter >= 80 mm, simply cold-formed or cold-finished, containing by weight >= 2,5% nickel', 'iron_steel_products'),
  ('72222019', 'Bars and rods of stainless steel, of circular cross-section of a diameter >= 80 mm, simply cold-formed or cold-finished, containing by weight < 2,5% nickel', 'iron_steel_products'),
  ('72222021', 'Bars and rods of stainless steel, not further worked than cold-formed or cold-finished, of circular cross-section measuring >= 25 mm but < 80 mm and containing by weight >= 2,5% nickel', 'iron_steel_products'),
  ('72222029', 'Bars and rods of stainless steel, not further worked than cold-formed or cold-finished, of circular cross-section measuring >= 25 mm but < 80 mm and containing by weight < 2,5% nickel', 'iron_steel_products'),
  ('72222031', 'Bars and rods of stainless steel, not further worked than cold-formed or cold-finished, of circular cross-section measuring < 25 mm and containing by weight >= 2,5% nickel', 'iron_steel_products'),
  ('72222039', 'Bars and rods of stainless steel, not further worked than cold-formed or cold-finished, of circular cross-section measuring < 25 mm and containing by weight < 2,5% nickel', 'iron_steel_products'),
  ('72222081', 'Bars and rods of stainless steel, not further worked than cold-formed or cold-finished, containing by weight >= 2,5% nickel (excl. such products of circular cross-section)', 'iron_steel_products'),
  ('72222089', 'Bars and rods of stainless steel, not further worked than cold-formed or cold-finished, containing by weight < 2,5% nickel (excl. such products of circular cross-section)', 'iron_steel_products'),
  ('72223051', 'Other bars and rods of stainless steel, containing by weight >= 2,5% of nickel, forged', 'iron_steel_products'),
  ('72223091', 'Other bars and rods of stainless steel, containing by weight < 2,5% of nickel, forged', 'iron_steel_products'),
  ('72223097', 'Bars and rods of stainless steel, cold-formed or cold-finished and further worked, or hot-formed and further worked, n.e.s. (excl. forged products)', 'iron_steel_products'),
  ('72224010', 'Angles, shapes and sections of stainless steel, only hot-rolled, only hot-drawn or only extruded', 'iron_steel_products'),
  ('72224050', 'Angles, shapes and sections of stainless steel, not further worked than cold-formed or cold-finished', 'iron_steel_products'),
  ('72224090', 'Angles, shapes and sections of stainless steel, cold-formed or cold-finished and further worked, or not further worked than forged, or forged, or hot-formed by other means and further worked, n.e.s.', 'iron_steel_products'),
  ('72230011', 'Wire of stainless steel, in coils, containing by weight 28% to 31% nickel and 20% to 22% chromium (excl. bars and rods)', 'iron_steel_products'),
  ('72230019', 'Wire of stainless steel, in coils, containing by weight >= 2,5% nickel (excl. such products containing 28% to 31% nickel and 20% to 22% chromium, and bars and rods)', 'iron_steel_products'),
  ('72230091', 'Wire of stainless steel, in coils, containing by weight < 2,5% nickel, 13% to 25% chromium and 3,5% to 6% aluminium (excl. bars and rods)', 'iron_steel_products'),
  ('72230099', 'Wire of stainless steel, in coils, containing by weight < 2,5% nickel (excl. such products containing 13% to 25% chromium and 3,5% to 6% aluminium, and bars and rods)', 'iron_steel_products'),
  ('72241010', 'Ingots and other primary forms, of tool steel', 'crude_steel'),
  ('72241090', 'Steel, alloy, other than stainless, in ingots or other primary forms (excl. of tool steel, waste and scrap in ingot form and products obtained by continuous casting)', 'crude_steel'),
  ('72249002', 'Semi-finished products of tool steel', 'crude_steel'),
  ('72249003', 'Semi-finished products of high-speed steel, of square or rectangular cross-section, hot-rolled or obtained by continuous casting the width measuring < twice the thickness', 'crude_steel'),
  ('72249005', 'Semi-finished products of steel containing by weight <= 0,7% of carbon, 0,5% to 1,2% of manganese, 0,6% to 2,3% of silicon, or of steel containing by weight >= 0,0008% of boron with any other element < the minimum content referred to in Note 1 f to chapter 72, of square or rectangular cross-section, hot rolled or obtained by continuous casting, the width measuring < twice the thickness', 'crude_steel'),
  ('72249007', 'Semi-finished products of alloy steel other than stainless steel, of square or rectangular cross-section, hot-rolled or obtained by continuous casting, the width measuring < twice the thickness (excl. of tool steel, high-speed steel and articles of subheading 7224.90.05)', 'crude_steel'),
  ('72249014', 'Semi-finished products of alloy steel other than stainless steel, of square or rectangular cross-section, hot-rolled or obtained by continuous casting, the width measuring >= twice the thickness (excl. of tool steel)', 'crude_steel'),
  ('72249018', 'Semi-finished products of alloy steel other than stainless steel, of square or rectangular cross-section, forged (excl. of tool steel)', 'crude_steel'),
  ('72249031', 'Semi-finished products of steel containing by weight 0,9% to 1,15% carbon, 0,5% to 2% of chromium and, if present, <= 0,5% of molybdenum, cut into shapes other than square or rectangular, hot-rolled or obtained by continuous casting', 'crude_steel'),
  ('72249038', 'Semi-finished products of alloy steel, other than stainless steel, cut into shapes other than square or rectangular, hot-rolled or obtained by continuous casting (excl. of tool steel and products containing by weight 0,9% to 1,15% of carbon, 0,5% to 2% of chromium and, if present, <= 0,5% of molybdenum)', 'crude_steel'),
  ('72249090', 'Semi-finished products of alloy steel, other than stainless steel, forged (excl. of tool steel and products of square or rectangular, circular or polygamol cross-section)', 'crude_steel'),
  ('72251100', 'Flat-rolled products of silicon-electrical steel, of a width of >= 600 mm, grain-oriented', 'iron_steel_products'),
  ('72251910', 'Flat-rolled products of silicon-electrical steel, of a width of >= 600 mm, hot-rolled', 'iron_steel_products'),
  ('72251990', 'Flat-rolled products of silicon-electrical steel, of a width of >= 600 mm, cold-rolled "cold-reduced", non-grain-oriented', 'iron_steel_products'),
  ('72253010', 'Flat-rolled products of tool steel, of a width of >= 600 mm, not further worked than hot-rolled, in coils', 'iron_steel_products'),
  ('72253030', 'Flat-rolled products of high-speed steel, of a width of >= 600 mm, not further worked than hot-rolled, in coils', 'iron_steel_products'),
  ('72253090', 'Flat-rolled products of alloy steel other than stainless, of a width of >= 600 mm, not further worked than hot-rolled, in coils (excl. products of tool steel, high-speed steel or silicon-electrical steel)', 'iron_steel_products'),
  ('72254012', 'Flat-rolled products of tool steel, of a width of >= 600 mm, not further worked than hot-rolled, not in coils', 'iron_steel_products'),
  ('72254015', 'Flat-rolled products of high-speed steel, of a width of >= 600 mm, not further worked than hot-rolled, not in coils', 'iron_steel_products'),
  ('72254040', 'Flat-rolled products of alloy steel other than stainless, of a width of >= 600 mm, not further worked than hot-rolled, not in coils, of a thickness of > 10 mm (excl. products of tool steel, high-speed steel or silicon-electrical steel)', 'iron_steel_products'),
  ('72254060', 'Flat-rolled products of alloy steel other than stainless, of a width of >= 600 mm, not further worked than hot-rolled, not in coils, of a thickness of >= 4,75 mm but <= 10 mm (excl. products of tool steel, high-speed steel or silicon-electrical steel)', 'iron_steel_products'),
  ('72254090', 'Flat-rolled products of alloy steel other than stainless, of a width of >= 600 mm, not further worked than hot-rolled, not in coils, of a thickness of < 4,75 mm (excl. products of tool steel, high-speed steel or silicon-electrical steel)', 'iron_steel_products'),
  ('72255020', 'Flat-rolled products of high-speed steel, of a width of >= 600 mm, not further worked than cold-rolled "cold-reduced"', 'iron_steel_products'),
  ('72255080', 'Flat-rolled products of alloy steel other than stainless, of a width of >= 600 mm, not further worked than cold-rolled "cold-reduced" (excl. products of high-speed steel or silicon-electrical steel)', 'iron_steel_products'),
  ('72259100', 'Flat-rolled products of alloy steel other than stainless, of a width of >= 600 mm, hot-rolled or cold-rolled "cold-reduced" and electrolytically plated or coated with zinc (excl. products of silicon-electrical steel)', 'iron_steel_products'),
  ('72259200', 'Flat-rolled products of alloy steel other than stainless, of a width of >= 600 mm, hot-rolled or cold-rolled "cold-reduced" and plated or coated with zinc (excl. electrolytically plated or coated and products of silicon-electrical steel)', 'iron_steel_products'),
  ('72259900', 'Flat-rolled products of alloy steel other than stainless, of a width of >= 600 mm, hot-rolled or cold-rolled "cold-reduced" and further worked (excl. plated or coated with zinc and products of silicon-electrical steel)', 'iron_steel_products'),
  ('72261100', 'Flat-rolled products of silicon-electrical steel, of a width of < 600 mm, hot-rolled or cold-rolled "cold-reduced", grain-oriented', 'iron_steel_products'),
  ('72261910', 'Flat-rolled products of silicon-electrical steel, of a width of < 600 mm, not further worked than hot-rolled', 'iron_steel_products'),
  ('72261980', 'Flat-rolled products of silicon-electrical steel, of a width of < 600 mm, cold-rolled "cold-reduced", whether or not further worked, or hot-rolled and further worked, non-grain-oriented', 'iron_steel_products'),
  ('72262000', 'Flat-rolled products of high-speed steel, of a width of <= 600 mm, hot-rolled or cold-rolled "cold-reduced"', 'iron_steel_products'),
  ('72269120', 'Flat-rolled products of tool steel, of a width of < 600 mm, simply hot-rolled', 'iron_steel_products'),
  ('72269191', 'Flat-rolled products of alloy steel other than stainless steel, simply hot-rolled, of a thickness of >= 4,75 mm, of a width of < 600 mm (excl. of tool steel, silicon-electrical steel or high speed steel)', 'iron_steel_products'),
  ('72269199', 'Flat-rolled products of alloy steel other than stainless steel, simply hot-rolled, of a thickness of < 4,75 mm, of a width of < 600 mm (excl. of tool steel, silicon-electrical steel or high speed steel)', 'iron_steel_products'),
  ('72269200', 'Flat-rolled products of alloy steel other than stainless, of a width of < 600 mm, not further worked than cold-rolled "cold-reduced" (excl. products of high-speed steel or silicon-electrical steel)', 'iron_steel_products'),
  ('72269910', 'Flat-rolled products of alloy steel other than stainless, of a width of < 600 mm, hot-rolled or cold-rolled "cold-reduced" and electrolytically plated or coated with zinc (excl. products of high-speed steel or silicon-electrical steel)', 'iron_steel_products'),
  ('72269930', 'Flat-rolled products of alloy steel other than stainless, of a width of < 600 mm, hot-rolled or cold-rolled "cold-reduced" and plated or coated with zinc (excl. electrolytically plated or coated, and products of high-speed steel or silicon-electrical steel)', 'iron_steel_products'),
  ('72269970', 'Flat-rolled products of alloy steel other than stainless, of a width of < 600 mm, hot-rolled or cold-rolled "cold-reduced" and further worked (excl. plated or coated with zinc, and products of high-speed steel or silicon-electrical steel)', 'iron_steel_products'),
  ('72271000', 'Bars and rods of high-speed steel, hot-rolled, in irregularly wound coils', 'iron_steel_products'),
  ('72272000', 'Bars and rods of silico-manganese steel, hot-rolled, in irregularly wound coils', 'iron_steel_products'),
  ('72279010', 'Bars and rods, hot-rolled, of steel containing by weight >= 0,0008% of boron with any other element < the minimum content referred to in Note 1 f to this chapter, in irregularly wound coils', 'iron_steel_products'),
  ('72279050', 'Bars and rods, hot-rolled, of steel containing by weight 0,9% to 1,15% carbon, 0,5% to 2% of chromium and, if present, <= 0,5 of molybdenum, in irregularly wound coils', 'iron_steel_products'),
  ('72279095', 'Bars and rods, hot-rolled, in irregularly wound coils of alloy steel other than stainless (excl. of high-speed steel or silico-manganese steel and bars and rods of subheadings 7227.90.10 and 7227.90.50)', 'iron_steel_products'),
  ('72281020', 'Bars and rods of high-speed steel, not further worked than hot-rolled, hot-drawn or extruded, and hot-rolled, hot-drawn or extruded, not further worked than clad (excl. semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72281050', 'Bars and rods of high-speed steel, forged (excl. semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72281090', 'Bars and rods of high-speed steel, not further worked than cold-formed or cold-finished, whether or not further worked, or hot-formed and further worked (excl. forged products, semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72282010', 'Bars and rods of silico-manganese steel, of rectangular "other than square" cross-section, hot-rolled on four faces (excl. semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72282091', 'Bars and rods of silico-manganese steel, of square or other than rectangular cross-section, not further worked than hot-rolled, hot-drawn or extruded, and hot-rolled, hot-drawn or extruded, not further worked than clad (excl. semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72282099', 'Bars and rods of silico-manganese stee, of square or other than rectangular cross-section, only cold-formed or cold-finished, incl. further worked, or hot-rolled and further worked (excl. hot-rolled, hot drawn or extruded, not further worked than clad, semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72283020', 'Bars and rods of tool steel, only hot-rolled, only hot-drawn or only extruded (excl. semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72283041', 'Bars and rods of steel containing by weight 0,9 to 1,15% of carbon and 0,5 to 2% of chromium, and, if present, <= 0,5% of molybdenum, only hot-rolled, hot-drawn or hot-extruded, of a circular cross-section of a diameter of >= 80 mm (excl. semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72283049', 'Bars and rods of steel containing by weight 0,9 to 1,15% of carbon and 0,5 to 2% of chromium, and, if present, <= 0,5% of molybdenum, only hot-rolled, only hot-drawn or hot-extruded (other than of circular cross-section, of a diameter of >= 80 mm and excl. semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72283061', 'Bars and rods of alloy steel other than stainless steel, only hot-rolled, hot-drawn or hot-extruded, of circular cross-section, of a diameter of >= 80 mm (other than of high-speed steel, silico-manganese steel, tool steel, articles of subheading 7228.30.41 and excl. semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72283069', 'Bars and rods or alloy steel other than stainless steel, only hot-rolled, hot-drawn or hot-extruded, of circular cross-section, of a diameter of < 80 mm (other than of high-speed steel, silico-manganese steel, tool steel and articles of subheading 7228.30.49 and excl. semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72283070', 'Bars and rods of alloy steel other than stainless steel, of rectangular "other than square" cross-section, hot-rolled on four faces (other than of high-speed steel, silico-manganese steel, tool steel, articles of subheading 7228.30.41 and 7228.30.49 and excl. semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72283089', 'Bars and rods of alloy steel other than stainless steel, only hot-rolled, hot-drawn or hot-extruded, of other than rectangular [other than square] cross-section, rolled on four faces, or of circular cross-section (other than of high-speed steel, silico-manganese steel, tool steel, articles of subheading 7228.30.49 and excl. semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72284010', 'Bars and rods of tool steel, only forged (excl. semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72284090', 'Bars and rods of alloy steel, other than stainless steel, only forged (excl. of high-speed steel, silico-manganese steel, tool steel, semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72285020', 'Bars and rods of tool steel, only cold-formed or cold-finished (excl. semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72285040', 'Bars and rods of steel containing 0,9% to 1,15% of carbon, 0,5% to 2% of chromium and, if present <= 0,5% of molybdenum, only cold-formed or cold-finished (excl. semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72285061', 'Bars and rods of alloy steel, other than stainless steel, not further worked than cold-formed or cold-finished, of circular cross-section, of a diameter of >= 80 mm (excl. of high-speed steel, silico-manganese steel, tool steel, articles of subheading 7228.50.40, semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72285069', 'Bars and rods of alloy steel, other than stainless steel, not further worked than cold-formed or cold-finished, of circular cross-section, of a diameter of < 80 mm (excl. of high-speed steel, silico-manganese steel, tool steel, articles of subheading 7228.50.40, semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72285080', 'Bars and rods of alloy steel, other than stainless steel, not further worked than cold-formed or cold-finished (excl. of circular cross-section and products of high-speed steel, silico-manganese steel, tool steel, articles of subheading 7228.50.40, semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72286020', 'Bars and rods of tool steel, cold-formed or cold-finished and further worked or hot-formed and further worked (excl. semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72286080', 'Bars and rods of alloy steel, other than stainless steel, cold-formed or cold-finished and further worked or hot-formed and further worked (excl. bars and rods of high-speed steel, silico-manganese steel or tool steel, semi-finished products, flat-rolled products and hot-rolled bars and rods in irregularly wound coils)', 'iron_steel_products'),
  ('72287010', 'Angles, shapes and sections of alloy steel other than stainless, not further worked than hot-rolled, hot-drawn or extruded', 'iron_steel_products'),
  ('72287090', 'Angles, shapes and sections of alloy steel other than stainless, n.e.s. (excl. products not further worked than hot-rolled, hot-drawn or extruded)', 'iron_steel_products'),
  ('72288000', 'Hollow drill bars and rods, of alloy or non-alloy steel', 'iron_steel_products'),
  ('72292000', 'Wire of silico-manganese steel, in coils (excl. bars and rods)', 'iron_steel_products'),
  ('72299020', 'Wire of high-speed steel, in coils (excl. bars and rods)', 'iron_steel_products'),
  ('72299050', 'Wire of steel containing by weight 0,9% to 1,1% of carbon, 0,5% to 2% of chromium and, if present, <= 0,5% of molybdenum, in coils (excl. rolled bars and rods)', 'iron_steel_products'),
  ('72299090', 'Wire of alloy steel other than stainless, in coils (excl. rolled bars and rods, wire of high-speed steel or silico-manganese steel and articles of subheading 7229.90.50)', 'iron_steel_products'),
  ('73011000', 'Sheet piling of iron or steel, whether or not drilled, punched or made from assembled elements', 'iron_steel_products'),
  ('73012000', 'Angles, shapes and sections, of iron or steel, welded', 'iron_steel_products'),
  ('73021010', 'Current-conducting rails of iron or steel, with parts of non-ferrous metal, for railway or tramway track (excl. check-rails)', 'iron_steel_products'),
  ('73021022', 'Vignole rails of iron or steel, for railway or tramway track, new, of a weight of >= 36 kg/m', 'iron_steel_products'),
  ('73021028', 'Vignole rails of iron or steel, for railway or tramway track, new, of a weight of < 36 kg/m', 'iron_steel_products'),
  ('73021040', 'Grooved rails of iron or steel, for railway or tramway track, new', 'iron_steel_products'),
  ('73021050', 'Rails of iron or steel, for railway or tramway track, new (excl. vignole rails, grooved rails, and current-conducting rails with parts of non-ferrous metal)', 'iron_steel_products'),
  ('73021090', 'Rails of iron or steel, for railway or tramway track, used (excl. current-conducting rails with parts of non-ferrous metal)', 'iron_steel_products'),
  ('73023000', 'Switch blades, crossing frogs, point rods and other crossing pieces, for railway or tramway track, of iron or steel', 'iron_steel_products'),
  ('73024000', 'Fish-plates and sole plates of iron or steel, for railways or tramways', 'iron_steel_products'),
  ('73029000', 'Sleepers "cross-ties", check-rails, rack rails, chairs, chair wedges, rail clips, bedplates and ties and other specialised material for the jointing or fixing of railway or tramway track, of iron or steel (excl. rails, switch blades, crossing frogs, point rods and other crossing pieces, and fish-plates and sole plates)', 'iron_steel_products'),
  ('73030010', 'Tubes and pipes of a kind used in pressure systems, of cast iron', 'iron_steel_products'),
  ('73030090', 'Tubes, pipes and hollow profiles, of cast iron (excl. products of a kind used in pressure systems)', 'iron_steel_products'),
  ('73041100', 'Line pipe of a kind used for oil or gas pipelines, seamless, of stainless steel', 'iron_steel_products'),
  ('73041910', 'Line pipe of a kind used for oil or gas pipelines, seamless, of iron or steel, of an external diameter of <= 168,3 mm (excl. products of stainless steel or of cast iron)', 'iron_steel_products'),
  ('73041930', 'Line pipe of a kind used for oil or gas pipelines, seamless, of iron or steel, of an external diameter of > 168,3 mm but <= 406,4 mm (excl. products of stainless steel or of cast iron)', 'iron_steel_products'),
  ('73041990', 'Line pipe of a kind used for oil or gas pipelines, seamless, of iron or steel, of an external diameter of > 406,4 mm (excl. products of stainless steel or of cast iron)', 'iron_steel_products'),
  ('73042200', 'Drill pipe, seamless, of stainless steel, of a kind used in drilling for oil or gas', 'iron_steel_products'),
  ('73042300', 'Drill pipe, seamless, of a kind used in drilling for oil or gas, of iron or steel (excl. products of stainless steel or of cast iron)', 'iron_steel_products'),
  ('73042400', 'Casing and tubing, seamless, of a kind used for drilling for oil or gas, of stainless steel', 'iron_steel_products'),
  ('73042910', 'Casing and tubing of a kind used for drilling for oil or gas, seamless, of iron or steel, of an external diameter <= 168,3 mm (excl. products of cast iron)', 'iron_steel_products'),
  ('73042930', 'Casing and tubing of a kind used for drilling for oil or gas, seamless, of iron or steel, of an external diameter > 168,3 mm, but <= 406,4 mm (excl. products of cast iron)', 'iron_steel_products'),
  ('73042990', 'Casing and tubing of a kind used for drilling for oil or gas, seamless, of iron or steel, of an external diameter > 406,4 mm (excl. products of cast iron)', 'iron_steel_products'),
  ('73043120', 'Precision tubes, seamless, of circular cross-section, of iron or non-alloy steel, cold-drawn or cold-rolled "cold-reduced" (excl. line pipe of a kind used for oil or gas pipelines or casing and tubing of a kind used for drilling for oil or gas)', 'iron_steel_products'),
  ('73043180', 'Tubes, pipes and hollow profiles, seamless, of circular cross-section, of iron or non-alloy steel, cold-drawn or cold-rolled "cold-reduced" (excl. cast iron products, line pipe of a kind used for oil or gas pipelines, casing and tubing of a kind used for drilling for oil or gas and precision tubes)', 'iron_steel_products'),
  ('73043950', 'Threaded or threadable tubes "gas pipe", seamless, of iron or non-alloy steel (excl. of cast iron)', 'iron_steel_products'),
  ('73043982', 'Tubes, pipes and hollow profiles, seamless, of circular cross-section, of iron or non-alloy steel, of an external diameter of <= 168,3 mm (excl. cold-drawn or cold-rolled, of cast iron, line pipe of a kind used for oil or gas pipelines, casing, tubing and drill pipe of a kind used in drilling for oil or gas and tubes, and gas pipes of subheading 7304 39 50)', 'iron_steel_products'),
  ('73043983', 'Tubes, pipes and hollow profiles, seamless, of circular cross-section, of iron or non-alloy steel, of an external diameter of > 168,3 mm but <= 406,4 mm (excl. cold-drawn or cold-rolled, of cast iron, line pipe of a kind used for oil or gas pipelines, casing, tubing and drill pipe of a kind used in drilling for oil or gas and tubes, and gas pipes of subheading 7304 39 50)', 'iron_steel_products'),
  ('73043988', 'Tubes, pipes and hollow profiles, seamless, of circular cross-section, of iron or non-alloy steel, of an external diameter of > 406,4 mm (excl. cold-drawn or cold-rolled, of cast iron, line pipe of a kind used for oil or gas pipelines, casing, tubing and drill pipe of a kind used in drilling for oil or gas and tubes, and gas pipes of subheading 7304 39 50)', 'iron_steel_products'),
  ('73044100', 'Tubes, pipes and hollow profiles, seamless, of circular cross-section, of stainless steel, cold-drawn or cold-rolled "cold-reduced" (excl. line pipe of a kind used for oil or gas pipelines, casing and tubing of a kind used for drilling for oil or gas)', 'iron_steel_products'),
  ('73044983', 'Tubes, pipes and hollow profiles, seamless, of circular cross-section, of stainless steel, of an external diameter of <= 168,3 mm (excl. cold-drawn or cold-rolled, line pipe of a kind used for oil or gas pipelines, and casing and tubing of a kind used for drilling for oil or gas and tubes)', 'iron_steel_products'),
  ('73044985', 'Tubes, pipes and hollow profiles, seamless, of circular cross-section, of stainless steel, of an external diameter of > 168,3 mm but <= 406,4 mm (excl. cold-drawn or cold-rolled, line pipe of a kind used for oil or gas pipelines, and casing and tubing of a kind used for drilling for oil or gas and tubes)', 'iron_steel_products'),
  ('73044989', 'Tubes, pipes and hollow profiles, seamless, of circular cross-section, of stainless steel, of an external diameter of > 406,4 mm (excl. cold-drawn or cold-rolled, line pipe of a kind used for oil or gas pipelines, and casing and tubing of a kind used for drilling for oil or gas and tubes)', 'iron_steel_products'),
  ('73045110', 'Tubes, pipes and hollow profiles, seamless, of circular cross-section, of alloy steel other than stainless, cold-drawn or cold-rolled "cold-reduced", straight and of uniform wall-thickness, containing by weight >= 0,9% but <= 1,15% carbon and >= 0,5% but <= 2% chromium, whether or not containing by weight <= 0,5% molybdenum (excl. tubes, pipes and hollow profiles of subheadings 7304 19 to 7304 29)', 'iron_steel_products'),
  ('73045181', 'Precision tubes, seamless, of circular cross-section, of alloy steel other than stainless, cold-drawn or cold-rolled "cold-reduced" (excl. line pipe of a kind used for oil or gas pipelines, casing and tubing of a kind used for drilling for oil and tubes, and pipes and hollow profiles, straight and of uniform wall-thickness, containing by weight >= 0,9% but <= 1,15% carbon and >= 0,5% but <= 2% chrome, whether or not containing by weight <= 0,5% molybdenum)', 'iron_steel_products'),
  ('73045189', 'Tubes, pipes and hollow profiles, seamless, of circular cross-section, of alloy steel other than stainless, not cold-drawn or cold-rolled "cold-reduced" (excl. line pipe of a kind used for oil or gas pipelines, casing and tubing of a kind used for drilling for oil, precision tubes, and , pipes and hollow profiles, straight and of uniform wall-thickness, containing by weight >= 0,9% but <= 1,15% carbon and >= 0,5% but <= 2% chrome, whether or not containing by weight <= 0,5% molybdenum)', 'iron_steel_products'),
  ('73045930', 'Tubes, pipes and hollow profiles of alloy steel (excl. stainless), seamless, of circular cross-section (not cold-drawn or cold-rolled), straight and of uniform wall-thickness, containing by weight >= 0,9% but <= 1,15% carbon and >= 0,5% but <= 2% chromium, whether or not containing by weight <= 0,5% molybdenum (excl. tubes, pipes and hollow profiles of subheadings 7304 19 to 7304 29)', 'iron_steel_products'),
  ('73045982', 'Tubes, pipes and hollow profiles, seamless, of circular cross-section, of alloy steel other than stainless, of an external diameter of <= 168,3 mm (excl. cold-drawn or cold-rolled, line pipe of a kind used for oil or gas pipelines, casing and tubing of a kind used for drilling for oil or gas, and products of subheading 7304 59 30)', 'iron_steel_products'),
  ('73045983', 'Tubes, pipes and hollow profiles, seamless, of circular cross-section, of alloy steel other than stainless, of an external diameter of > 168,3 mm but <= 406,4 mm (excl. cold-drawn or cold-rolled, line pipe of a kind used for oil or gas pipelines, casing and tubing of a kind used for drilling for oil or gas, and products of subheading 7304 59 30)', 'iron_steel_products'),
  ('73045989', 'Tubes, pipes and hollow profiles, seamless, of circular cross-section, of alloy steel other than stainless, of an external diameter of > 406,4 mm (excl. cold-drawn or cold-rolled, line pipe of a kind used for oil or gas pipelines, casing and tubing of a kind used for drilling for oil or gas, and products of subheading 7304 59 30)', 'iron_steel_products'),
  ('73049000', 'Tubes, pipes and hollow profiles, seamless, of non-circular cross-section, of iron or steel (excl. products of cast iron)', 'iron_steel_products'),
  ('73051100', 'Line pipe of a kind used for oil or gas pipelines, having circular cross-sections and an external diameter of > 406,4 mm, of iron or steel, longitudinally submerged arc welded', 'iron_steel_products'),
  ('73051200', 'Line pipe of a kind used for oil or gas pipelines, having circular cross-sections and an external diameter of > 406,4 mm, of iron or steel, longitudinally arc welded (excl. products longitudinally submerged arc welded)', 'iron_steel_products'),
  ('73051900', 'Line pipe of a kind used for oil or gas pipelines, having circular cross-sections and an external diameter of > 406,4 mm, of flat-rolled products of iron or steel (excl. products longitudinally arc welded)', 'iron_steel_products'),
  ('73052000', 'Casing of a kind used in drilling for oil or gas, having circular cross-sections and an external diameter of > 406,4 mm, of flat-rolled products of iron or steel', 'iron_steel_products'),
  ('73053100', 'Tubes and pipes having circular cross-sections and an external diameter of > 406,4 mm, of iron or steel, longitudinally welded (excl. products of a kind used for oil or gas pipelines or of a kind used in drilling for oil or gas)', 'iron_steel_products'),
  ('73053900', 'Tubes and pipes having circular cross-sections and an external diameter of > 406,4 mm, of iron or steel, welded (excl. products longitudinally welded or of a kind used for oil or gas pipelines or of a kind used in drilling for oil or gas)', 'iron_steel_products'),
  ('73059000', 'Tubes and pipes having circular cross-sections and an external diameter of > 406,4 mm, of flat-rolled products of iron or steel, welded (excl. welded products or products of a kind used for oil or gas pipelines or of a kind used in drilling for oil or gas)', 'iron_steel_products'),
  ('73061100', 'Line pipe of a kind used for oil or gas pipelines, welded, of flat-rolled products of stainless steel, of an external diameter of <= 406,4 mm', 'iron_steel_products'),
  ('73061900', 'Line pipe of a kind used for oil or gas pipelines, welded, of flat-rolled products of iron or steel, of an external diameter of <= 406,4 mm (excl. products of stainless steel or of cast iron)', 'iron_steel_products'),
  ('73062100', 'Casing and tubing of a kind used in drilling for oil or gas, welded, of flat-rolled products of stainless steel, of an external diameter of <= 406,4 mm', 'iron_steel_products'),
  ('73062900', 'Casing and tubing of a kind used in drilling for oil or gas, welded, of flat-rolled products of iron or steel, of an external diameter of <= 406,4 mm (excl. products of stainless steel or of cast iron)', 'iron_steel_products'),
  ('73063012', 'Precision tubes, welded, of circular cross-section, of iron or non-alloy steel, cold-drawn or cold-rolled "cold-reduced"', 'iron_steel_products'),
  ('73063018', 'Precision tubes, welded, of circular cross-section, of iron or non-alloy steel (excl. cold-drawn or cold-rolled)', 'iron_steel_products'),
  ('73063041', 'Threaded or threadable tubes "gas pipe", welded, of circular cross-section, of iron or non-alloy steel, plated or coated with zinc', 'iron_steel_products'),
  ('73063049', 'Threaded or threadable tubes "gas pipe", welded, of circular cross-section, of iron or non-alloy steel (excl. products plated or coated with zinc)', 'iron_steel_products'),
  ('73063072', 'Other tubes, pipes and hollow profiles, welded, of circular cross-section, of iron or non-alloy steel, of an external diameter of <= 168,3 mm, plated or coated with zinc (excl. line pipe of a kind used for oil or gas pipelines or casing and tubingof a kind used in drilling for oil or gas)', 'iron_steel_products'),
  ('73063077', 'Other tubes, pipes and hollow profiles, welded, of circular cross-section, of iron or non-alloy steel of an external diameter of <= 168,3 mm (excl. plated or coated with zinc and line pipe of a kind used for oil or gas pipelines, casing and tubing of a kind used in drilling for oil or gas, precision tubes and threaded or threadable tubes "gas pipe")', 'iron_steel_products'),
  ('73063080', 'Tubes, pipes and hollow profiles, welded, having a circular cross-section, of iron or steel, of an external diameter of > 168,3 mm but <= 406,4 mm (excl. line pipe of a kind used for oil or gas pipelines or casing and tubing of a kind used in drilling for oil or gas, or precision steel tubes, electrical conduit tubes or threaded or threadable tubes "gas pipe")', 'iron_steel_products'),
  ('73064020', 'Tubes, pipes and hollow profiles, welded, of circular cross-section, of stainless steel, cold-drawn or cold-rolled "cold-reduced" (excl. products having internal and external circular cross-sections and an external diameter of > 406,4 mm, and line pipe of a kind used for oil or gas pipelines or casing and tubing of a kind used in drilling for oil or gas)', 'iron_steel_products'),
  ('73064080', 'Tubes, pipes and hollow profiles, welded, of circular cross-section, of stainless steel (excl. products cold-drawn or cold-rolled "cold-reduced", tubes and pipes having internal and external circular cross-sections and an external diameter of > 406,4 mm, and line pipe of a kind used for oil or gas pipelines or casing and tubing of a kind used in drilling for oil or gas)', 'iron_steel_products'),
  ('73065021', 'Precision steel tubes, welded, of circular cross-section, of alloy steel other than stainless, cold-drawn or cold-rolled "cold-reduced"', 'iron_steel_products'),
  ('73065029', 'Precision steel tubes, welded, of circular cross-section, of alloy steel other than stainless (excl. cold-drawn or cold-rolled)', 'iron_steel_products'),
  ('73065080', 'Tubes, pipes and hollow profiles, welded, of circular cross-section, of alloy steel other than stainless (excl. tubes and pipes having internal and external circular cross-sections and an external diameter of > 406,4 mm, and line pipe of a kind used for oil or gas pipelines or casing and tubing of a kind used in drilling for oil or gas, and precision steel tubes)', 'iron_steel_products'),
  ('73066110', 'Tubes and pipes and hollow profiles, welded, of square or rectangular cross-section, of stainless steel', 'iron_steel_products'),
  ('73066192', 'Tubes and pipes and hollow profiles, welded, of square or rectangular cross-section, of iron or steel other than stainless steel, with a wall thickness of <= 2 mm', 'iron_steel_products'),
  ('73066199', 'Tubes and pipes and hollow profiles, welded, of square or rectangular cross-section, of iron or steel other than stainless steel, with a wall thickness of > 2 mm', 'iron_steel_products'),
  ('73066910', 'Tubes, pipes and hollow profiles, welded, of non-circular cross-section, of stainless steel (excl. tubes and pipes having internal and external circular cross-sections and an external diameter of > 406,4 mm, line pipe of a kind used for oil or gas pipelines or casing and tubing of a kind used in drilling for oil or gas, and tubes and pipes and hollow profiles of square or rectangular cross-section)', 'iron_steel_products'),
  ('73066990', 'Tubes, pipes and hollow profiles, welded, of non-circular cross-section, of iron or steel other than stainless steel (excl. tubes and pipes having internal and external circular cross-sections and an external diameter of > 406,4 mm, line pipe of a kind used for oil or gas pipelines or casing and tubing of a kind used in drilling for oil or gas, and tubes and pipes and hollow profiles of square or rectangular cross-section)', 'iron_steel_products'),
  ('73069000', 'Tubes, pipes and hollow profiles "e.g., open seam, riveted or similarly closed", of iron or steel (excl. of cast iron, seamless or welded tubes and pipes and tubes and pipes having internal and external circular cross-sections and an external diameter of > 406,4 mm)', 'iron_steel_products'),
  ('73071110', 'Tube or pipe fittings of non-malleable cast iron, of a kind used in pressure systems', 'iron_steel_products'),
  ('73071190', 'Tube or pipe fittings of non-malleable cast iron (excl. products of a kind used in pressure systems)', 'iron_steel_products'),
  ('73071910', 'Tube or pipe fittings of cast iron (excl. of non-malleable)', 'iron_steel_products'),
  ('73071990', 'Cast tube or pipe fittings of steel', 'iron_steel_products'),
  ('73072100', 'Flanges of stainless steel (excl. cast products)', 'iron_steel_products'),
  ('73072210', 'Sleeves, of stainless steel, threaded (excl. cast products)', 'iron_steel_products'),
  ('73072290', 'Elbows and bends, of stainless steel, threaded (excl. cast products)', 'iron_steel_products'),
  ('73072310', 'Butt welding elbows and bends of stainless steel (excl. cast products)', 'iron_steel_products'),
  ('73072390', 'Butt welding tube or pipe fittings of stainless steel (excl. cast products and elbows and bends)', 'iron_steel_products'),
  ('73072910', 'Threaded tube or pipe fittings of stainless steel (excl. cast products, flanges, elbows, bends and sleeves)', 'iron_steel_products'),
  ('73072980', 'Tube or pipe fittings of stainless steel (excl. cast, threaded, butt welding fittings and flanges)', 'iron_steel_products'),
  ('73079100', 'Flanges of iron or steel (excl. cast or stainless products)', 'iron_steel_products'),
  ('73079210', 'Sleeves of iron or steel, threaded (excl. cast or of stainless steel)', 'iron_steel_products'),
  ('73079290', 'Elbows and bends, of iron or steel, threaded (excl. cast or of stainless steel)', 'iron_steel_products'),
  ('73079311', 'Butt welding elbows and bends, of iron or steel, with greatest external diameter <= 609,6 mm (excl. cast iron or stainless steel products)', 'iron_steel_products'),
  ('73079319', 'Butt welding fittings of iron or steel, with greatest external diameter <= 609,6 mm (excl. cast iron or stainless steel products, elbows, bends and flanges)', 'iron_steel_products'),
  ('73079391', 'Butt welding elbows and bends, of iron or steel, with greatest external diameter > 609,6 mm (excl. cast iron or stainless steel products)', 'iron_steel_products'),
  ('73079399', 'Butt welding fittings of iron or steel, with greatest external diameter > 609,6 mm (excl. cast iron or stainless steel products, elbows, bends and flanges)', 'iron_steel_products'),
  ('73079910', 'Threaded tube or pipe fittings, of iron or steel (excl. cast iron or stainless steel products, flanges, elbows, bends and sleeves)', 'iron_steel_products'),
  ('73079980', 'Tube or pipe fittings, of iron or steel (excl. of cast iron or stainless steel, threaded, butt welding fittings, and flanges)', 'iron_steel_products'),
  ('73081000', 'Bridges and bridge-sections, of iron or steel', 'iron_steel_products'),
  ('73082000', 'Towers and lattice masts, of iron or steel', 'iron_steel_products'),
  ('73083000', 'Doors, windows and their frames and thresholds for doors, of iron or steel', 'iron_steel_products'),
  ('73084000', 'Equipment for scaffolding, shuttering, propping or pit-propping (excl. composite sheetpiling products and formwork panels for poured-in-place concrete, which have the characteristics of moulds)', 'iron_steel_products'),
  ('73089051', 'Panels comprising two walls of profiled "ribbed" sheet, of iron or steel, with an insulating core', 'iron_steel_products'),
  ('73089059', 'Structures and parts of structures, of iron or steel, solely or principally of sheet, n.e.s. (excl. doors and windows and their frames, and panels comprising two walls of profiled "ribbed" sheet, of iron or steel, with an insulating core)', 'iron_steel_products'),
  ('73089098', 'Structures and parts of structures of iron or steel, n.e.s. (excl. bridges and bridge-sections; towers; lattice masts; doors, windows and their frames and thresholds; equipment for scaffolding, shuttering, propping or pit-propping, and products made principally of sheet)', 'iron_steel_products'),
  ('73090010', 'Reservoirs, tanks, vats and similar containers, of iron or steel, for gases other than compressed or liquefied gas, of a capacity of > 300 l (excl. containers fitted with mechanical or thermal equipment and containers specifically constructed or equipped for one or more types of transport)', 'iron_steel_products'),
  ('73090030', 'Reservoirs, tanks, vats and similar containers, of iron or steel, for liquids, lined or heat-insulated and of a capacity of > 300 l (excl. containers fitted with mechanical or thermal equipment and containers specifically constructed or equipped for one or more types of transport)', 'iron_steel_products'),
  ('73090051', 'Reservoirs, tanks, vats and similar containers, of iron or steel, for liquids, of a capacity of > 100.000 l (excl. containers lined or heat-insulated or fitted with mechanical or thermal equipment and containers specifically constructed or equipped for one or more types of transport)', 'iron_steel_products'),
  ('73090059', 'Reservoirs, tanks, vats and similar containers, of iron or steel, for liquids, of a capacity of <= 100.000 l but > 300 l (excl. containers lined or heat-insulated or fitted with mechanical or thermal equipment and containers specifically constructed or equipped for one or more types of transport)', 'iron_steel_products'),
  ('73090090', 'Reservoirs, tanks, vats and similar containers, of iron or steel, for solids, of a capacity of > 300 l (excl. containers lined or heat-insulated or fitted with mechanical or thermal equipment and containers specifically constructed or equipped for one or more types of transport)', 'iron_steel_products'),
  ('73101000', 'Tanks, casks, drums, cans, boxes and similar containers, of iron or steel, for any material, of a capacity of >= 50 l but <= 300 l, n.e.s. (excl. containers for compressed or liquefied gas, or containers fitted with mechanical or thermal equipment)', 'iron_steel_products'),
  ('73102111', 'Cans of iron or steel, of a capacity of < 50 l, which are to be closed by soldering or crimping, of a kind used for preserving food', 'iron_steel_products'),
  ('73102119', 'Cans of iron or steel, of a capacity of < 50 l, which are to be closed by soldering or crimping, of a kind used for preserving drink', 'iron_steel_products'),
  ('73102191', 'Cans of iron or steel, of a capacity of < 50 l, which are to be closed by soldering or crimping, of a wall thickness of < 0,5 mm (excl. cans for compressed or liquefied gas, and cans of a kind used for preserving food and drink)', 'iron_steel_products'),
  ('73102199', 'Cans of iron or steel, of a capacity of < 50 l, which are to be closed by soldering or crimping, of a wall thickness of >= 0,5 mm (excl. cans for compressed or liquefied gas, and cans of a kind used for preserving food and drink)', 'iron_steel_products'),
  ('73102910', 'Tanks, casks, drums, cans, boxes and similar containers, of iron or steel, for any material, of a capacity of < 50 l and of a wall thickness of < 0,5 mm, n.e.s. (excl. containers for compressed or liquefied gas, or containers fitted with mechanical or thermal equipment, and cans which are to be closed by soldering or crimping)', 'iron_steel_products'),
  ('73102990', 'Tanks, casks, drums, cans, boxes and similar containers, of iron or steel, for any material, of a capacity of < 50 l and of a wall thickness of >= 0,5 mm, n.e.s. (excl. containers for compressed or liquefied gas, or containers fitted with mechanical or thermal equipment, and cans which are to be closed by soldering or crimping)', 'iron_steel_products'),
  ('73110011', 'Containers of iron or steel, seamless, for compressed or liquefied gas, for a pressure >= 165 bar, of a capacity < 20 l (excl. containers specifically constructed or equipped for one or more types of transport)', 'iron_steel_products'),
  ('73110013', 'Containers of iron or steel, seamless, for compressed or liquefied gas, for a pressure >= 165 bar, of a capacity >= 20 l to <= 50 l (excl. containers specifically constructed or equipped for one or more types of transport)', 'iron_steel_products'),
  ('73110019', 'Containers of iron or steel, seamless, for compressed or liquefied gas, for a pressure >= 165 bar, of a capacity > 50 l (excl. containers specifically constructed or equipped for one or more types of transport)', 'iron_steel_products'),
  ('73110030', 'Containers of iron or steel, seamless, for compressed or liquefied gas, for a pressure < 165 bar (excl. containers specifically constructed or equipped for one or more types of transport)', 'iron_steel_products'),
  ('73110091', 'Containers of iron or steel, seamless, for compressed or liquefied gas, of a capacity of < 1.000 l (excl. seamless containers and containers specifically constructed or equipped for one or more types of transport)', 'iron_steel_products'),
  ('73110099', 'Containers of iron or steel, seamless, for compressed or liquefied gas, of a capacity of >= 1.000 l (excl. seamless containers and containers specifically constructed or equipped for one or more types of transport)', 'iron_steel_products'),
  ('73181100', 'Coach screws of iron or steel', 'iron_steel_products'),
  ('73181210', 'Wood screws of stainless steel (excl. coach screws)', 'iron_steel_products'),
  ('73181290', 'Wood screws of iron or steel other than stainless (excl. coach screws)', 'iron_steel_products'),
  ('73181300', 'Screw hooks and screw rings, of iron or steel', 'iron_steel_products'),
  ('73181410', 'Self-tapping screws, of stainless steel (excl. wood screws)', 'iron_steel_products'),
  ('73181491', 'Spaced-thread screws of iron or steel other than stainless', 'iron_steel_products'),
  ('73181499', 'Self-tapping screws of iron or steel other than stainless (excl. spaced-thread screws and wood screws)', 'iron_steel_products'),
  ('73181520', 'Screws and bolts, of iron or steel "whether or not with their nuts and washers", for fixing railway track construction material (excl. coach screws)', 'iron_steel_products'),
  ('73181535', 'Screws and bolts, of stainless steel "whether or not with their nuts and washers", without heads (excl. screws and bolts for fixing railway track construction material)', 'iron_steel_products'),
  ('73181542', 'Screws and bolts, of iron or steel other than stainless "whether or not with their nuts and washers", without heads, with a tensile strength of < 800 MPa (excl. screws and bolts for fixing railway track construction material)', 'iron_steel_products'),
  ('73181548', 'Screws and bolts, of iron or steel other than stainless "whether or not with their nuts and washers", without heads, with a tensile strength of >= 800 MPa (excl. screws and bolts for fixing railway track construction material)', 'iron_steel_products'),
  ('73181552', 'Screws and bolts, of stainless steel "whether or not with their nuts and washers", with slotted or cross-recessed heads (excl. wood screws and self-tapping screws)', 'iron_steel_products'),
  ('73181558', 'Screws and bolts, of iron or steel other than stainless "whether or not with their nuts and washers", with slotted or cross-recessed heads (excl. wood screws and self-tapping screws)', 'iron_steel_products'),
  ('73181562', 'Hexagonal-socket head screws and bolts, of stainless steel "whether or not with their nuts and washers" (excl. wood screws, self-tapping screws and screws and bolts for fixing railway track construction material)', 'iron_steel_products'),
  ('73181568', 'Hexagonal-socket head screws and bolts, of iron or steel other than stainless "whether or not with their nuts and washers" (excl. wood screws, self-tapping screws and screws and bolts for fixing railway track construction material)', 'iron_steel_products'),
  ('73181575', 'Hexagon screws and bolts, of stainless steel "whether or not with their nuts and washers" (excl. with socket head, wood screws, self-tapping screws and screws and bolts for fixing railway track construction material)', 'iron_steel_products'),
  ('73181582', 'Hexagon screws and bolts, of iron or steel other than stainless "whether or not with their nuts and washers", with a tensile strength of < 800 MPa (excl. with socket head, wood screws, self-tapping screws and screws and bolts for fixing railway track construction material)', 'iron_steel_products'),
  ('73181588', 'Hexagon screws and bolts, of iron or steel other than stainless "whether or not with their nuts and washers", with a tensile strength of => 800 MPa (excl. with socket head, wood screws, self-tapping screws and screws and bolts for fixing railway track construction material)', 'iron_steel_products'),
  ('73181595', 'Screws and bolts, of iron or steel "whether or not with their nuts and washers", with heads (excl. with slotted, cross-recessed or hexagonal head; wood screws, self-tapping screws and screws and bolts for fixing railway track construction material, screw hooks and screw rings)', 'iron_steel_products'),
  ('73181631', 'Blind rivet nuts of stainless steel', 'iron_steel_products'),
  ('73181639', 'Nuts of stainless steel (excl. blind rivet nuts)', 'iron_steel_products'),
  ('73181640', 'Blind rivet nuts of iron or steel other than stainless', 'iron_steel_products'),
  ('73181660', 'Self-locking nuts of iron or steel other than stainless', 'iron_steel_products'),
  ('73181692', 'Nuts of iron or steel other than stainless, with an inside diameter <= 12 mm (excl. blind rivet nuts and self-locking nuts)', 'iron_steel_products'),
  ('73181699', 'Nuts of iron or steel other than stainless, with an inside diameter > 12 mm (excl. blind rivet nuts and self-locking nuts)', 'iron_steel_products'),
  ('73181900', 'Threaded articles, of iron or steel, n.e.s.', 'iron_steel_products'),
  ('73182100', 'Spring washers and other lock washers, of iron or steel', 'iron_steel_products'),
  ('73182200', 'Washers of iron or steel (excl. spring washers and other lock washers)', 'iron_steel_products'),
  ('73182300', 'Rivets of iron or steel (excl. tubular and bifurcated rivets for particular uses)', 'iron_steel_products'),
  ('73182400', 'Cotters and cotter pins, of iron or steel', 'iron_steel_products'),
  ('73182900', 'Non-threaded articles, of iron or steel', 'iron_steel_products'),
  ('73261100', 'Grinding balls and similar articles for mills, of iron or steel, forged or stamped, but not further worked', 'iron_steel_products'),
  ('73261910', 'Articles of iron or steel, open-die forged, but not further worked, n.e.s. (excl. grinding balls and similar articles for mills)', 'iron_steel_products'),
  ('73261990', 'Articles of iron or steel, closed-die forged or stamped, but not further worked, n.e.s. (excl. grinding balls and similar articles for mills)', 'iron_steel_products'),
  ('73262000', 'Articles of iron or steel wire, n.e.s.', 'iron_steel_products'),
  ('73269030', 'Ladders and steps, of iron or steel', 'iron_steel_products'),
  ('73269040', 'Pallets and similar platforms for handling goods, of iron or steel', 'iron_steel_products'),
  ('73269050', 'Reels for cables, piping and the like, of iron or steel', 'iron_steel_products'),
  ('73269060', 'Ventilators, non-mechanical, guttering, hooks and like articles used in the building industry, n.e.s., of iron or steel', 'iron_steel_products'),
  ('73269092', 'Articles of iron or steel, open-die forged, n.e.s.', 'iron_steel_products'),
  ('73269094', 'Articles of iron or steel, closed-die forged, n.e.s.', 'iron_steel_products'),
  ('73269096', 'Sintered articles of iron or steel, n.e.s.', 'iron_steel_products'),
  ('73269098', 'Articles of iron or steel, n.e.s.', 'iron_steel_products'),
  ('76011010', 'Aluminium slabs, not alloyed, unwrought', 'unwrought_aluminium'),
  ('76011090', 'Aluminium, not alloyed, unwrought (excl. slabs)', 'unwrought_aluminium'),
  ('76012030', 'Unwrought aluminium alloys in the form of slabs', 'unwrought_aluminium'),
  ('76012040', 'Unwrought aluminium alloys in the form of billets', 'unwrought_aluminium'),
  ('76012080', 'Unwrought aluminium alloys (excl. slabs and billets)', 'unwrought_aluminium'),
  ('76031000', 'Powders of aluminium, of non-lamellar structure (excl. pellets of aluminium)', 'aluminium_products'),
  ('76032000', 'Powders of aluminium, of lamellar structure, and flakes of aluminium (excl. pellets of aluminium, and spangles)', 'aluminium_products'),
  ('76041010', 'Bars, rods and profiles, of non-alloy aluminium', 'aluminium_products'),
  ('76041090', 'Profiles of non-alloy aluminium, n.e.s.', 'aluminium_products'),
  ('76042100', 'Hollow profiles of aluminium alloys, n.e.s.', 'aluminium_products'),
  ('76042910', 'Bars and rods of aluminium alloys', 'aluminium_products'),
  ('76042990', 'Solid profiles, of aluminium alloys, n.e.s.', 'aluminium_products'),
  ('76051100', 'Wire of non-alloy aluminium, with a maximum cross-sectional dimension of > 7 mm (excl. stranded wire, cables, plaited bands and the like and other articles of heading 7614, and electrically insulated wires)', 'aluminium_products'),
  ('76051900', 'Wire of non-alloy aluminium, with a maximum cross-sectional dimension of <= 7 mm (other than stranded wires, cables, ropes and other articles of heading 7614, electrically insulated wires, strings for musical instruments)', 'aluminium_products'),
  ('76052100', 'Wire of aluminium alloys, with a maximum cross-sectional dimension of > 7 mm (excl. stranded wire, cables, plaited bands and the like and other articles of heading 7614, and electrically insulated wires)', 'aluminium_products'),
  ('76052900', 'Wire, of aluminium alloys, having a maximum cross-sectional dimension of <= 7 mm (other than stranded wires, cables, ropes and other articles of heading 7614, electrically insulated wires, strings for musical instruments)', 'aluminium_products'),
  ('76061130', 'Aluminium Composite Panel, of non-alloy aluminium, of a thickness of > 0,2 mm', 'aluminium_products'),
  ('76061150', 'Plates, sheets and strip, of non-alloy aluminium, of a thickness of > 0,2 mm, square or rectangular, painted, varnished or coated with plastics (excl. Aluminium Composite Panel)', 'aluminium_products'),
  ('76061191', 'Plates, sheets and strip, of non-alloy aluminium, of a thickness of > 0,2 mm but < 3 mm, square or rectangular (excl. such products painted, varnished or coated with plastics, and expanded plates, sheets and strip)', 'aluminium_products'),
  ('76061193', 'Plates, sheets and strip, of non-alloy aluminium, of a thickness of >= 3 mm but < 6 mm, square or rectangular (excl. such products painted, varnished or coated with plastics)', 'aluminium_products'),
  ('76061199', 'Plates, sheets and strip, of non-alloy aluminium, of a thickness of >= 6 mm, square or rectangular (excl. such products painted, varnished or coated with plastics)', 'aluminium_products'),
  ('76061211', 'Beverage can body stock, of aluminium alloys, of a thickness of > 0,2 mm', 'aluminium_products'),
  ('76061219', 'Beverage can end stock and tab stock, of aluminium alloys, of a thickness of > 0,2 mm', 'aluminium_products'),
  ('76061230', 'Aluminium Composite Panel, of aluminium alloys, of a thickness of > 0,2 mm', 'aluminium_products'),
  ('76061250', 'Plates, sheets and strip, of aluminium alloys, of a thickness of > 0,2 mm, square or rectangular, painted, varnished or coated with plastics (excl. beverage can body stock, end stock and tab stock, and Aluminium Composite Panel)', 'aluminium_products'),
  ('76061292', 'Plates, sheets and strip, of aluminium alloys, of a thickness of > 0,2 mm but < 3 mm, square or rectangular (excl. painted, varnished or coated with plastics, expanded plates, sheets and strip, beverage can body stock, end stock and tab stock)', 'aluminium_products'),
  ('76061293', 'Plates, sheets and strip, of aluminium alloys, of a thickness of >= 3 mm but < 6 mm, square or rectangular (excl. such products painted, varnished or coated with plastics)', 'aluminium_products'),
  ('76061299', 'Plates, sheets and strip, of aluminium alloys, of a thickness of >= 6 mm, square or rectangular (excl. such products painted, varnished or coated with plastics)', 'aluminium_products'),
  ('76069100', 'Plates, sheets and strip, of non-alloy aluminium, of a thickness of > 0,2 mm (other than square or rectangular)', 'aluminium_products'),
  ('76069200', 'Plates, sheets and strip, of aluminium alloys, of a thickness of > 0,2 mm (other than square or rectangular)', 'aluminium_products'),
  ('76071111', 'Aluminium foil, not backed, rolled but not further worked, of a thickness of < 0,021 mm, in rolls of a weight of <= 10 kg (excl. stamping foils of heading 3212, and foil made up as christmas tree decorating material)', 'aluminium_products'),
  ('76071119', 'Aluminium foil, not backed, rolled but not further worked, of a thickness of < 0,021 mm (excl. stamping foils of heading 3212, and foil made up as christmas tree decorating material and in rolls of a weight <= 10 kg)', 'aluminium_products'),
  ('76071190', 'Aluminium foil, not backed, rolled but not further worked, of a thickness of >= 0,021 mm but <= 2 mm (excl. stamping foils of heading 3212, and foil made up as christmas tree decorating material)', 'aluminium_products'),
  ('76071910', 'Aluminium foil, not backed, rolled and further worked, of a thickness of < 0,021 mm (excl. stamping foils of heading 3212, and foil made up as christmas tree decorating material)', 'aluminium_products'),
  ('76071990', 'Aluminium foil, not backed, rolled and further worked, of a thickness (excl. any backing) from 0,021 mm to 0,2 mm (excl. stamping foils of heading 3212, and foil made up as christmas tree decorating material)', 'aluminium_products'),
  ('76072010', 'Aluminium foil, backed, of a thickness (excl. any backing) of < 0,021 mm (excl. stamping foils of heading 3212, and foil made up as christmas tree decorating material)', 'aluminium_products'),
  ('76072091', 'Aluminium Composite Panel, of a thickness <= 0,2 mm', 'aluminium_products'),
  ('76072099', 'Aluminium foil, backed, of a thickness (excl. any backing) of >= 0,021 mm but <= 0,2 mm (excl. stamping foils of heading 3212, foil made up as christmas tree decorating material, and Aluminium Composite Panel)', 'aluminium_products'),
  ('76081000', 'Tubes and pipes of non-alloy aluminium (excl. hollow profiles)', 'aluminium_products'),
  ('76082020', 'Tubes and pipes of aluminium alloys, welded (excl. hollow profiles)', 'aluminium_products'),
  ('76082081', 'Tubes and pipes of aluminium alloys, not further worked than extruded (excl. hollow profiles)', 'aluminium_products'),
  ('76082089', 'Tubes and pipes of aluminium alloys (excl. such products welded or not further worked than extruded, and hollow profiles)', 'aluminium_products'),
  ('76090000', 'Aluminium tube or pipe fittings "e.g., couplings, elbows, sleeves"', 'aluminium_products'),
  ('76101000', 'Doors, windows and their frames and thresholds for door, of aluminium (excl. door furniture)', 'aluminium_products'),
  ('76109010', 'Bridges and bridge-sections, towers and lattice masts, of aluminium', 'aluminium_products'),
  ('76109090', 'Structures and parts of structures, of aluminium, n.e.s., and plates, rods, profiles, tubes and the like, prepared for use in structures, of aluminium, n.e.s. (excl. prefabricated buildings of heading 9406, doors and windows and their frames and thresholds for doors, bridges and bridge-sections, towers and lattice masts)', 'aluminium_products'),
  ('76110000', 'Reservoirs, tanks, vats and similar containers, of aluminium, for any material (other than compressed or liquefied gas), of a capacity of > 300 l, not fitted with mechanical or thermal equipment, whether or not lined or heat-insulated (excl. containers specifically constructed or equipped for one or more types of transport)', 'aluminium_products'),
  ('76121000', 'Collapsible tubular containers, of aluminium', 'aluminium_products'),
  ('76129020', 'Containers of a kind used for aerosols, of aluminium', 'aluminium_products'),
  ('76129030', 'Casks, drums, cans, boxes and similar containers, of aluminium, manufactured from foil of a thickness <= 0,2 mm', 'aluminium_products'),
  ('76129080', 'Casks, drums, cans, boxes and similar containers <= 300 l, of aluminium, for any material (other than compressed or liquefied gas), n.e.s. (other than collapsible tubular containers, containers for aerosols and containers manufactured from foil of a thickness <= 0,2 mm', 'aluminium_products'),
  ('76130000', 'Aluminium containers for compressed or liquefied gas', 'aluminium_products'),
  ('76141000', 'Stranded wire, cables, plaited bands and the like, of aluminium, with steel core (excl. such products electrically insulated)', 'aluminium_products'),
  ('76149000', 'Stranded wires, cables, ropes and similar articles, of aluminium (other than with steel core and electrically insulated products)', 'aluminium_products'),
  ('76161000', 'Nails, tacks, staples, screws, bolts, nuts, screw hooks, rivets, cotters, cotter pins, washers and similar articles, of aluminium (excl. staples in strips, plugs, bungs and the like, threaded)', 'aluminium_products'),
  ('76169100', 'Cloth, grill, netting and fencing, of aluminium wire (excl. cloth of metal fibres for clothing, lining and similar uses, and cloth, grill and netting made into hand sieves or machine parts)', 'aluminium_products'),
  ('76169910', 'Articles of aluminium, cast, n.e.s.', 'aluminium_products'),
  ('76169990', 'Articles of aluminium, uncast, n.e.s.', 'aluminium_products'),
  ('27160000', 'Electrical energy', 'electricity')
) as v (code, description, cat);

-- Template constants CONST_GWP_N2O/CF4/C2F6 and CONST_EFNatGas.
insert into library_factor (library_version_id, kind, subject, value, unit, value_si, si_unit,
                            valid_from, source, created_at, created_by, updated_at, updated_by)
select m.version_id, v.kind, v.subject, v.value, v.unit, v.value, v.unit, date '2026-01-01',
       m.src || ' (' || v.cell || ')', m.at, m.by, m.at, m.by
  from seed_meta m, (values
  ('gwp', 'N2O', 265::numeric, 'tCO2e/tGHG', 'CONST_GWP_N2O'),
  ('gwp', 'CF4', 6630, 'tCO2e/tGHG', 'CONST_GWP_CF4'),
  ('gwp', 'C2F6', 11100, 'tCO2e/tGHG', 'CONST_GWP_C2F6'),
  ('emission_factor', 'Natural gas', 56.1, 'tCO2/TJ', 'CONST_EFNatGas')
) as v (kind, subject, value, unit, cell);

-- ---------------------------------------------------------------------------
-- Register: row metadata, audit, forced RLS. The import payload is not copied to the log.
-- ---------------------------------------------------------------------------

select app.register_business_table('public.template_version');
select app.register_business_table('public.library_version');
select app.register_business_table('public.goods_category');
select app.register_business_table('public.production_route');
select app.register_business_table('public.route_relevant_precursor');
select app.register_business_table('public.qualifying_parameter_def');
select app.register_business_table('public.cn_code');
select app.register_business_table('public.library_factor');
select app.register_business_table('public.library_import', '{rows}');
select app.register_business_table('public.client_factor_override');

-- ---------------------------------------------------------------------------
-- Immutability (M4-R2), enforced in the database: SQLSTATE 55000 (the API answers 409).
-- ---------------------------------------------------------------------------

create function app.guard_library_version() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'A library version starts as a draft' using errcode = 'object_not_in_prerequisite_state';
    end if;
    new.published_at := null;
    new.published_by := null;
    return new;
  end if;
  if old.status = 'published' then
    raise exception 'Library version % is published and cannot be changed', old.code
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if new.based_on_id is distinct from old.based_on_id then
    raise exception 'A library version cannot be rebased' using errcode = 'object_not_in_prerequisite_state';
  end if;
  if new.status = 'published' then
    new.published_at := now();
    new.published_by := app.current_user_id();
  end if;
  return new;
end
$$;
create trigger guard_library_version before insert or update or delete on library_version
  for each row execute function app.guard_library_version();

-- Content of a published version is frozen. A missing (or RLS-hidden) parent means the draft itself is
-- being deleted (cascade), which is allowed.
create function app.guard_library_content() returns trigger
  language plpgsql
  as $$
declare
  v_status text;
begin
  if tg_op = 'UPDATE' and new.library_version_id is distinct from old.library_version_id then
    raise exception 'Library content cannot move to another version' using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- FOR SHARE: waits for a publish in progress and then sees 'published' (review M4 F1).
  select status into v_status from library_version
   where id = case when tg_op = 'DELETE' then old.library_version_id else new.library_version_id end
     for share;
  if v_status = 'published' then
    raise exception 'Library version is published and cannot be changed'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

do $$
declare t text;
begin
  foreach t in array array['goods_category', 'production_route', 'route_relevant_precursor',
                           'qualifying_parameter_def', 'cn_code', 'library_factor', 'library_import'] loop
    execute format('create trigger guard_library_content before insert or update or delete on %I
                      for each row execute function app.guard_library_content()', t);
  end loop;
end
$$;

create function app.reject_template_change() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'A registered template version cannot be changed or removed'
    using errcode = 'object_not_in_prerequisite_state';
end
$$;
create trigger template_version_frozen before update or delete on template_version
  for each row execute function app.reject_template_change();

-- Override lifecycle: proposed → approved | rejected | withdrawn; approved → withdrawn.
-- Only the platform admin decides. Nothing but the status fields changes after insert.
create function app.guard_factor_override() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'proposed' then
      raise exception 'An override starts as a proposal' using errcode = 'object_not_in_prerequisite_state';
    end if;
    new.decided_by := null;
    new.decided_at := null;
    new.decision_note := null;
    return new;
  end if;
  if (to_jsonb(new) - array['status', 'decided_by', 'decided_at', 'decision_note', 'updated_at', 'updated_by'])
     is distinct from
     (to_jsonb(old) - array['status', 'decided_by', 'decided_at', 'decision_note', 'updated_at', 'updated_by']) then
    raise exception 'An override cannot be edited; withdraw it and propose a new one'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if not ((old.status = 'proposed' and new.status in ('approved', 'rejected', 'withdrawn'))
          or (old.status = 'approved' and new.status = 'withdrawn')) then
    raise exception 'An override cannot go from % to %', old.status, new.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if new.status in ('approved', 'rejected') then
    if not app.is_platform_admin() then
      raise exception 'Only the platform admin approves or rejects overrides' using errcode = 'insufficient_privilege';
    end if;
    new.decided_by := app.current_user_id();
    new.decided_at := now();
  end if;
  return new;
end
$$;
create trigger guard_factor_override before insert or update on client_factor_override
  for each row execute function app.guard_factor_override();
create trigger client_factor_override_fixed_client before update on client_factor_override
  for each row execute function app.forbid_client_change();

-- ---------------------------------------------------------------------------
-- Copy the content of one version into a new draft (security invoker: RLS applies).
-- ---------------------------------------------------------------------------

create function app.clone_library_content(p_from uuid, p_to uuid) returns void
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
revoke execute on function app.clone_library_content(uuid, uuid) from public;
grant execute on function app.clone_library_content(uuid, uuid) to cbam_app;

-- ---------------------------------------------------------------------------
-- `(select …)` evaluates the check once per statement, not once per row (review M4 F18).
-- Policies (G1, G2, D1, D12). Library: everyone reads; only the operator tenant's platform
-- admins write.
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['library_version', 'goods_category', 'production_route', 'route_relevant_precursor',
                           'qualifying_parameter_def', 'cn_code', 'library_factor', 'template_version'] loop
    execute format('create policy %I on %I for select to cbam_app using (true)', t || '_read', t);
    execute format('create policy %I on %I for insert to cbam_app with check ((select app.is_library_admin()))', t || '_insert', t);
    execute format('create policy %I on %I for update to cbam_app using ((select app.is_library_admin())) with check ((select app.is_library_admin()))', t || '_update', t);
    execute format('create policy %I on %I for delete to cbam_app using ((select app.is_library_admin()))', t || '_delete', t);
  end loop;
end
$$;
grant select, insert, update, delete on library_version, goods_category, production_route, route_relevant_precursor,
  qualifying_parameter_def, cn_code, library_factor to cbam_app;
grant select, insert on template_version to cbam_app;

create policy library_import_admin on library_import for all to cbam_app
  using ((select app.is_library_admin())) with check ((select app.is_library_admin()));
grant select, insert, update, delete on library_import to cbam_app;

-- Overrides: readable with the client; consultants and admins propose; the proposer can
-- withdraw; the admin decides (the guard trigger checks which transition is allowed).
create policy cfo_read on client_factor_override for select to cbam_app
  using (tenant_id = app.current_tenant_id() and client_id in (select app.accessible_client_ids()));
create policy cfo_insert on client_factor_override for insert to cbam_app
  with check (tenant_id = app.current_tenant_id() and app.can_manage_registry()
              and client_id in (select app.accessible_client_ids()));
create policy cfo_update on client_factor_override for update to cbam_app
  using (tenant_id = app.current_tenant_id() and client_id in (select app.accessible_client_ids())
         and (app.is_platform_admin() or (app.can_manage_registry() and created_by = app.current_user_id())))
  with check (tenant_id = app.current_tenant_id());
grant select, insert, update on client_factor_override to cbam_app;

-- migrate:down

drop table client_factor_override;
drop table library_import;
drop table library_factor;
drop table cn_code;
drop table qualifying_parameter_def;
drop table route_relevant_precursor;
drop table production_route;
drop table goods_category;
drop table library_version;
drop table template_version;
drop function app.clone_library_content(uuid, uuid);
drop function app.guard_factor_override();
drop function app.reject_template_change();
drop function app.guard_library_content();
drop function app.guard_library_version();
drop function auth.set_platform_operator(text);
drop function app.is_library_admin();
drop index tenant_one_platform_operator;
alter table tenant drop column is_platform_operator;
drop function app.is_platform_admin();

create or replace function audit.log_row_change() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $$
declare
  v_user    uuid := app.current_user_id();
  v_old     jsonb;
  v_new     jsonb;
  v_row     jsonb;
  v_changed text[];
  v_key     text;
begin
  if v_user is null then
    raise exception 'Write to %.% without a request context: app.user_id is not set',
      tg_table_schema, tg_table_name
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;

  if tg_op = 'UPDATE' then
    select array_agg(n.key order by n.key)
      into v_changed
      from jsonb_each(v_new) n
     where n.value is distinct from v_old -> n.key
       and n.key not in ('updated_at', 'updated_by');
    if v_changed is null then
      return null;  -- nothing but metadata changed
    end if;
  end if;

  foreach v_key in array coalesce(tg_argv::text[], '{}') loop
    if v_old ? v_key then v_old := jsonb_set(v_old, array[v_key], '"[redacted]"'); end if;
    if v_new ? v_key then v_new := jsonb_set(v_new, array[v_key], '"[redacted]"'); end if;
  end loop;

  v_row := coalesce(v_new, v_old);

  insert into audit.audit_log
    (tenant_id, client_id, actor_user_id, actor_role, action, op, table_name, record_id,
     old_row, new_row, changed_fields, request_id, reason)
  values (
    coalesce(v_row ->> 'tenant_id', case when tg_table_name = 'tenant' then v_row ->> 'id' end)::uuid,
    coalesce(v_row ->> 'client_id', case when tg_table_name = 'client' then v_row ->> 'id' end)::uuid,
    v_user,
    app.current_user_role(),
    nullif(current_setting('app.action', true), ''),
    tg_op,
    tg_table_schema || '.' || tg_table_name,
    v_row ->> 'id',
    v_old,
    v_new,
    v_changed,
    nullif(current_setting('app.request_id', true), ''),
    nullif(current_setting('app.reason', true), '')
  );
  return null;
end
$$;
