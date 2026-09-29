-- migrate:up

-- M2 — Client and installation registry. Also closes M1 review F5: FKs on the assignment
-- tables, the client/installation access helpers, and assignment policies.

grant create on schema app to cbam_auth;  -- to own the access helpers below

-- ---------------------------------------------------------------------------
-- ref_country (M2-R3). Codes and English names exactly as the official template's
-- country list (c_CodeLists F11:G277, template 2026-Q2), because sheet A cell I26
-- takes the template's name. Platform-wide reference data (decision D1); M4 owns updates.
-- ---------------------------------------------------------------------------

create table ref_country (
  code   char(2) primary key check (code ~ '^[A-Z]{2}$'),
  name   text not null,
  source text not null
);
insert into ref_country (code, name, source)
select code, name, 'CBAM Communication Template 2026-Q2, c_CodeLists' from (values
  ('AD', 'Andorra'),
  ('AE', 'United Arab Emirates'),
  ('AF', 'Afghanistan'),
  ('AG', 'Antigua and Barbuda'),
  ('AI', 'Anguilla'),
  ('AL', 'Albania'),
  ('AM', 'Armenia'),
  ('AN', 'Netherlands Antilles'),
  ('AO', 'Angola'),
  ('AQ', 'Aruban Florin'),
  ('AR', 'Argentina'),
  ('AS', 'American Samoa'),
  ('AT', 'Austria'),
  ('AU', 'Australia'),
  ('AW', 'Aruba'),
  ('AX', 'ÅLAND ISLANDS'),
  ('AZ', 'Azerbaijan'),
  ('BA', 'Bosnia and Herzegovina'),
  ('BB', 'Barbados'),
  ('BD', 'Bangladesh'),
  ('BE', 'Belgium'),
  ('BF', 'Burkina Faso'),
  ('BG', 'Bulgaria'),
  ('BH', 'Bahrain'),
  ('BI', 'Burundi'),
  ('BJ', 'Benin'),
  ('BL', 'Saint Barthélemy'),
  ('BM', 'Bermuda'),
  ('BN', 'Brunei Darussalam'),
  ('BO', 'Bolivia, Plurinational State of'),
  ('BQ', 'Bonaire, Sint Eustatius and Saba'),
  ('BR', 'Brazil'),
  ('BS', 'Bahamas'),
  ('BT', 'Bhutan'),
  ('BV', 'Bouvet Island'),
  ('BW', 'Botswana'),
  ('BY', 'Belarus'),
  ('BZ', 'Belize'),
  ('CA', 'Canada'),
  ('CC', 'Cocos Islands (or Keeling Islands)'),
  ('CD', 'Congo, Democratic Republic of'),
  ('CF', 'Central African Republic'),
  ('CG', 'Congo'),
  ('CH', 'Switzerland'),
  ('CI', 'Côte d''Ivoire'),
  ('CK', 'Cook Islands'),
  ('CL', 'Chile'),
  ('CM', 'Cameroon'),
  ('CN', 'China'),
  ('CO', 'Colombia'),
  ('CR', 'Costa Rica'),
  ('CU', 'Cuba'),
  ('CV', 'Cape Verde'),
  ('CW', 'Curaçao'),
  ('CX', 'Christmas Island'),
  ('CY', 'Cyprus'),
  ('CZ', 'Czechia'),
  ('DE', 'Germany'),
  ('DJ', 'Djibouti'),
  ('DK', 'Denmark'),
  ('DM', 'Dominica'),
  ('DO', 'Dominican Republic'),
  ('DZ', 'Algeria'),
  ('EC', 'Ecuador'),
  ('EE', 'Estonia'),
  ('EG', 'Egypt'),
  ('EH', 'Western Sahara'),
  ('ER', 'Eritrea'),
  ('ES', 'Spain'),
  ('ET', 'Ethiopia'),
  ('EU', 'European Community'),
  ('FI', 'Finland'),
  ('FJ', 'Fiji'),
  ('FK', 'Falkland Islands'),
  ('FM', 'Micronesia, Federated States of'),
  ('FO', 'Faroe Islands'),
  ('FR', 'France'),
  ('GA', 'Gabon'),
  ('GB', 'United Kingdom'),
  ('GD', 'Grenada'),
  ('GE', 'Georgia'),
  ('GF', 'French Guyana'),
  ('GG', 'Guernsey'),
  ('GH', 'Ghana'),
  ('GI', 'Gibraltar'),
  ('GL', 'Greenland'),
  ('GM', 'Gambia'),
  ('GN', 'Guinea'),
  ('GP', 'Guadeloupe'),
  ('GQ', 'Equatorial Guinea'),
  ('GR', 'Greece'),
  ('GS', 'South Georgia and South Sandwich'),
  ('GT', 'Guatemala'),
  ('GU', 'Guam'),
  ('GW', 'Guinea-Bissau'),
  ('GY', 'Guyana'),
  ('HK', 'Hong Kong'),
  ('HM', 'Heard Island and McDonald Islands'),
  ('HN', 'Honduras'),
  ('HR', 'Croatia'),
  ('HT', 'Haiti'),
  ('HU', 'Hungary'),
  ('ID', 'Indonesia'),
  ('IE', 'Ireland'),
  ('IL', 'Israel'),
  ('IM', 'Isle of Man'),
  ('IN', 'India'),
  ('IO', 'British Indian Ocean Territory'),
  ('IQ', 'Iraq'),
  ('IR', 'Iran, Islamic Republic of'),
  ('IS', 'Iceland'),
  ('IT', 'Italy'),
  ('JE', 'Jersey'),
  ('JM', 'Jamaica'),
  ('JO', 'Jordan'),
  ('JP', 'Japan'),
  ('KE', 'Kenya'),
  ('KG', 'Kyrgyz, Republic'),
  ('KH', 'Cambodia'),
  ('KI', 'Kiribati'),
  ('KM', 'Comoros'),
  ('KN', 'St Kitts and Nevis'),
  ('KP', 'Korea, Democratic People’s Republ'),
  ('KR', 'Korea, Republic of'),
  ('KW', 'Kuwait'),
  ('KY', 'Cayman Islands'),
  ('KZ', 'Kazakhstan'),
  ('LA', 'Lao People’s Democratic Republic'),
  ('LB', 'Lebanon'),
  ('LC', 'St Lucia'),
  ('LI', 'Liechtenstein'),
  ('LK', 'Sri Lanka'),
  ('LR', 'Liberia'),
  ('LS', 'Lesotho'),
  ('LT', 'Lithuania'),
  ('LU', 'Luxembourg'),
  ('LV', 'Latvia'),
  ('LY', 'Libya'),
  ('MA', 'Morocco'),
  ('MC', 'Monaco'),
  ('MD', 'Moldova, Republic of'),
  ('ME', 'Montenegro'),
  ('MF', 'Saint Martin (French part)'),
  ('MG', 'Madagascar'),
  ('MH', 'Marshall Islands'),
  ('MK', 'North Macedonia'),
  ('ML', 'Mali'),
  ('MM', 'Myanmar'),
  ('MN', 'Mongolia'),
  ('MO', 'Macao'),
  ('MP', 'Northern Mariana Islands'),
  ('MQ', 'Martinique'),
  ('MR', 'Mauritania'),
  ('MS', 'Montserrat'),
  ('MT', 'Malta'),
  ('MU', 'Mauritius'),
  ('MV', 'Maldives'),
  ('MW', 'Malawi'),
  ('MX', 'Mexico'),
  ('MY', 'Malaysia'),
  ('MZ', 'Mozambique'),
  ('NA', 'Namibia'),
  ('NC', 'New Caledonia'),
  ('NE', 'Niger'),
  ('NF', 'Norfolk Island'),
  ('NG', 'Nigeria'),
  ('NI', 'Nicaragua'),
  ('NL', 'Netherlands'),
  ('NO', 'Norway'),
  ('NP', 'Nepal'),
  ('NR', 'Nauru'),
  ('NU', 'Niue'),
  ('NZ', 'New Zealand'),
  ('OM', 'Oman'),
  ('PA', 'Panama'),
  ('PE', 'Peru'),
  ('PF', 'French Polynesia'),
  ('PG', 'Papua New Guinea'),
  ('PH', 'Philippines'),
  ('PK', 'Pakistan'),
  ('PL', 'Poland'),
  ('PM', 'St Pierre and Miquelon'),
  ('PN', 'Pitcairn'),
  ('PR', 'Puerto Rico'),
  ('PS', 'Occupied Palestinian Territory'),
  ('PT', 'Portugal'),
  ('PW', 'Palau'),
  ('PY', 'Paraguay'),
  ('QA', 'Qatar'),
  ('QP', 'High seas'),
  ('RE', 'Réunion'),
  ('RO', 'Romania'),
  ('RS', 'Serbia'),
  ('RU', 'Russian Federation'),
  ('RW', 'Rwanda'),
  ('SA', 'Saudi Arabia'),
  ('SB', 'Solomon Islands'),
  ('SC', 'Seychelles'),
  ('SD', 'Sudan'),
  ('SE', 'Sweden'),
  ('SG', 'Singapore'),
  ('SH', 'Saint Helena, Ascension and Tristan'),
  ('SI', 'Slovenia'),
  ('SJ', 'Svalbard and Jan Mayen Islands'),
  ('SK', 'Slovakia'),
  ('SL', 'Sierra Leone'),
  ('SM', 'San Marino'),
  ('SN', 'Senegal'),
  ('SO', 'Somalia'),
  ('SR', 'Suriname'),
  ('SS', 'South Sudan'),
  ('ST', 'Sao Tome and Principe'),
  ('SV', 'El Salvador'),
  ('SX', 'Sint Maarten (Dutch part)'),
  ('SY', 'Syrian Arab Republic'),
  ('SZ', 'Swaziland'),
  ('TC', 'Turks and Caicos Islands'),
  ('TD', 'Chad'),
  ('TF', 'French Southern Territories'),
  ('TG', 'Togo'),
  ('TH', 'Thailand'),
  ('TJ', 'Tajikistan'),
  ('TK', 'Tokelau'),
  ('TL', 'Timor-Leste'),
  ('TM', 'Turkmenistan'),
  ('TN', 'Tunisia'),
  ('TO', 'Tonga'),
  ('TP', 'East Timor'),
  ('TR', 'Türkiye'),
  ('TT', 'Trinidad and Tobago'),
  ('TV', 'Tuvalu'),
  ('TW', 'Taiwan'),
  ('TZ', 'Tanzania, United Republic of'),
  ('UA', 'Ukraine'),
  ('UG', 'Uganda'),
  ('UM', 'United States Minor Outlying Island'),
  ('US', 'United States'),
  ('UY', 'Uruguay'),
  ('UZ', 'Uzbekistan'),
  ('VA', 'Vatican City'),
  ('VC', 'St Vincent'),
  ('VE', 'Venezuela'),
  ('VG', 'British Virgin Islands'),
  ('VI', 'US Virgin Islands'),
  ('VN', 'Vietnam'),
  ('VU', 'Vanuatu'),
  ('WF', 'Wallis and Futuna Islands'),
  ('WS', 'Samoa'),
  ('XA', 'American Oceania'),
  ('XC', 'Ceuta'),
  ('XI', 'United Kingdom (Northern Ireland)'),
  ('XK', 'Kosovo'),
  ('XL', 'Melilla'),
  ('XM', 'Montenegro'),
  ('XO', 'Australian Oceania'),
  ('XP', 'West Bank and Gaza Strip'),
  ('XR', 'Polar regions'),
  ('XS', 'Serbia'),
  ('XZ', 'New Zealand Oceania'),
  ('YE', 'Yemen'),
  ('YT', 'Mayotte'),
  ('YU', 'Federal Republic of Yugoslavia'),
  ('ZA', 'South Africa'),
  ('ZM', 'Zambia'),
  ('ZR', 'Zaire'),
  ('ZW', 'Zimbabwe')
) as v (code, name);
grant select on ref_country to cbam_app, cbam_auth;

-- ---------------------------------------------------------------------------
-- client (operator company). Spec 4.1; operator fields are not in the template (D3).
-- ---------------------------------------------------------------------------

create table client (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant (id),
  legal_name       text not null check (length(btrim(legal_name)) between 1 and 300),
  registration_no  text check (length(registration_no) <= 100),
  address_line1    text not null check (length(btrim(address_line1)) between 1 and 300),
  address_line2    text check (length(address_line2) <= 300),
  postcode         text check (length(postcode) <= 40),
  city             text not null check (length(btrim(city)) between 1 and 200),
  country_code     char(2) not null references ref_country (code),
  contact_name     text not null check (length(btrim(contact_name)) between 1 and 200),
  contact_email    citext not null check (contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  contact_phone    text check (length(contact_phone) <= 50),
  deleted_at       timestamptz,
  created_at       timestamptz not null,
  created_by       uuid not null,
  updated_at       timestamptz not null,
  updated_by       uuid not null,
  unique (id, tenant_id)
);
select app.register_business_table('public.client');
-- M2-R5: same legal name in the same country is the same operator.
create unique index client_unique_name on client (tenant_id, lower(legal_name), country_code) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- installation. Every column maps to a sheet A_InstData cell (docs/mappings/template-A_InstData.md).
-- Coordinates are identification, not quantities, so they carry no unit/provenance (G5/G7).
-- ---------------------------------------------------------------------------

create table installation (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  client_id          uuid not null,
  name_local         text check (length(name_local) <= 300),                            -- I19
  name_en            text not null check (length(btrim(name_en)) between 1 and 300),    -- I20
  street             text not null check (length(btrim(street)) between 1 and 300),     -- I21
  economic_activity  text check (length(economic_activity) <= 300),                     -- I22
  postcode           text check (length(postcode) <= 40),                               -- I23
  po_box             text check (length(po_box) <= 40),                                 -- I24
  city               text not null check (length(btrim(city)) between 1 and 200),       -- I25
  country_code       char(2) not null references ref_country (code),                    -- I26 (as name)
  un_locode          char(5) check (un_locode ~ '^[A-Z]{2}[A-Z2-9]{3}$'),               -- I27
  latitude           numeric(8, 6) check (latitude between -90 and 90),                 -- I28
  longitude          numeric(9, 6) check (longitude between -180 and 180),              -- I29
  auth_rep_name      text check (length(auth_rep_name) <= 200),                         -- I30
  auth_rep_email     citext check (auth_rep_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),      -- I31
  auth_rep_phone     text check (length(auth_rep_phone) <= 50),                         -- I32
  permit_no          text check (length(permit_no) <= 100),                             -- not in template
  deleted_at         timestamptz,
  created_at         timestamptz not null,
  created_by         uuid not null,
  updated_at         timestamptz not null,
  updated_by         uuid not null,
  foreign key (client_id, tenant_id) references client (id, tenant_id),
  unique (id, client_id, tenant_id),
  -- UN/LOCODE starts with the country's code.
  check (un_locode is null or left(un_locode, 2) = country_code),
  check ((latitude is null) = (longitude is null))
);
select app.register_business_table('public.installation');
create index installation_client on installation (client_id);
-- M2-R5: one live installation per name within a client.
create unique index installation_unique_name on installation (client_id, lower(name_en)) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- eu_importer (M2-R1): EU importers or indirect customs representatives a client serves.
-- ---------------------------------------------------------------------------

create table eu_importer (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  client_id      uuid not null,
  name           text not null check (length(btrim(name)) between 1 and 300),
  eori           text not null check (eori ~ '^[A-Z]{2}[A-Z0-9]{1,15}$'),
  address_line1  text check (length(address_line1) <= 300),
  postcode       text check (length(postcode) <= 40),
  city           text check (length(city) <= 200),
  country_code   char(2) references ref_country (code),
  contact_name   text check (length(contact_name) <= 200),
  contact_email  citext check (contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  deleted_at     timestamptz,
  created_at     timestamptz not null,
  created_by     uuid not null,
  updated_at     timestamptz not null,
  updated_by     uuid not null,
  foreign key (client_id, tenant_id) references client (id, tenant_id)
);
select app.register_business_table('public.eu_importer');
create unique index eu_importer_unique_eori on eu_importer (client_id, eori) where deleted_at is null;

-- A record never moves to another client; create a new one instead.
create function app.forbid_client_change() returns trigger
  language plpgsql
  as $$
begin
  if new.client_id is distinct from old.client_id or new.tenant_id is distinct from old.tenant_id then
    raise exception 'A % cannot be moved to another client', tg_table_name using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger installation_fixed_client before update on installation
  for each row execute function app.forbid_client_change();
create trigger eu_importer_fixed_client before update on eu_importer
  for each row execute function app.forbid_client_change();

-- ---------------------------------------------------------------------------
-- Assignment FKs (M1 review F5). Installation assignments must match the installation's client.
-- ---------------------------------------------------------------------------

alter table user_client_assignment
  add constraint uca_client_fk foreign key (client_id, tenant_id) references client (id, tenant_id);
alter table user_installation_assignment
  add constraint uia_installation_fk foreign key (installation_id, client_id, tenant_id)
  references installation (id, client_id, tenant_id);

-- ---------------------------------------------------------------------------
-- Access helpers (G1, G2; decision D4). Admin: every client in the tenant. Contributor:
-- installations assigned to them (and those installations' clients). Other roles: assigned
-- clients and all their installations. SECURITY DEFINER so they can read assignments
-- that RLS hides from the caller; they only ever answer for the current user.
-- Policies use them as `x in (select app.accessible_…())`, evaluated once per statement.
-- ---------------------------------------------------------------------------

create function app.accessible_client_ids() returns setof uuid
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp
  as $$
    select c.id from client c
     where c.tenant_id = app.current_tenant_id()
       and case app.current_user_role()
             when 'platform_admin' then true
             when 'contributor' then exists (
               select 1 from user_installation_assignment a
                where a.client_id = c.id and a.user_id = app.current_user_id())
             else exists (
               select 1 from user_client_assignment a
                where a.client_id = c.id and a.user_id = app.current_user_id())
           end
  $$;

create function app.accessible_installation_ids() returns setof uuid
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp
  as $$
    select i.id from installation i
     where i.tenant_id = app.current_tenant_id()
       and case app.current_user_role()
             when 'platform_admin' then true
             when 'contributor' then exists (
               select 1 from user_installation_assignment a
                where a.installation_id = i.id and a.user_id = app.current_user_id())
             else exists (
               select 1 from user_client_assignment a
                where a.client_id = i.client_id and a.user_id = app.current_user_id())
           end
  $$;

-- Users assigned to any client the current user can access (team lists, assignment).
create function app.visible_user_ids() returns setof uuid
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp
  as $$
    select a.user_id from user_client_assignment a
     where a.client_id in (select app.accessible_client_ids())
    union
    select a.user_id from user_installation_assignment a
     where a.client_id in (select app.accessible_client_ids())
  $$;

-- A consultant who creates a client is assigned to it, so they can see what they made.
create function app.assign_client_creator() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp
  as $$
begin
  if app.current_user_role() = 'consultant' then
    insert into user_client_assignment (tenant_id, user_id, client_id)
    values (new.tenant_id, app.current_user_id(), new.id)
    on conflict (user_id, client_id) do nothing;
  end if;
  return null;
end
$$;
create trigger client_assign_creator after insert on client
  for each row execute function app.assign_client_creator();

grant select on client, installation, user_client_assignment, user_installation_assignment to cbam_auth;
grant insert on user_client_assignment to cbam_auth;

-- Privileges first, then ownership (see M1 migration: a non-owner's GRANT/REVOKE is skipped).
revoke execute on function app.accessible_client_ids(), app.accessible_installation_ids(),
  app.visible_user_ids() from public;
grant execute on function app.accessible_client_ids(), app.accessible_installation_ids(),
  app.visible_user_ids() to cbam_app;
alter function app.accessible_client_ids() owner to cbam_auth;
alter function app.accessible_installation_ids() owner to cbam_auth;
alter function app.visible_user_ids() owner to cbam_auth;
alter function app.assign_client_creator() owner to cbam_auth;

-- ---------------------------------------------------------------------------
-- Policies (G1, G2). Admins and consultants write; every role with access reads.
-- No DELETE grants: deletion is soft (M2-R6).
-- ---------------------------------------------------------------------------

create function app.can_manage_registry() returns boolean
  language sql stable
  as $$ select app.current_user_role() in ('platform_admin', 'consultant') $$;

create policy client_read on client for select to cbam_app
  using (tenant_id = app.current_tenant_id() and id in (select app.accessible_client_ids()));
create policy client_insert on client for insert to cbam_app
  with check (tenant_id = app.current_tenant_id() and app.can_manage_registry());
create policy client_update on client for update to cbam_app
  using (tenant_id = app.current_tenant_id() and app.can_manage_registry()
         and id in (select app.accessible_client_ids()))
  with check (tenant_id = app.current_tenant_id());

-- Installation access goes through the parent client; contributors are further limited to
-- their assigned installations. (Not `id in accessible_installation_ids()` alone: that
-- function reads this table at statement start, so INSERT … RETURNING could not see the new row.)
create function app.installation_visible(p_client_id uuid, p_id uuid) returns boolean
  language sql stable
  as $$
    select p_client_id in (select app.accessible_client_ids())
       and (app.current_user_role() <> 'contributor' or p_id in (select app.accessible_installation_ids()))
  $$;

create policy installation_read on installation for select to cbam_app
  using (tenant_id = app.current_tenant_id() and app.installation_visible(client_id, id));
create policy installation_insert on installation for insert to cbam_app
  with check (tenant_id = app.current_tenant_id() and app.can_manage_registry()
              and client_id in (select app.accessible_client_ids()));
create policy installation_update on installation for update to cbam_app
  using (tenant_id = app.current_tenant_id() and app.can_manage_registry()
         and app.installation_visible(client_id, id))
  with check (tenant_id = app.current_tenant_id());

create policy eu_importer_read on eu_importer for select to cbam_app
  using (tenant_id = app.current_tenant_id() and client_id in (select app.accessible_client_ids()));
create policy eu_importer_insert on eu_importer for insert to cbam_app
  with check (tenant_id = app.current_tenant_id() and app.can_manage_registry()
              and client_id in (select app.accessible_client_ids()));
create policy eu_importer_update on eu_importer for update to cbam_app
  using (tenant_id = app.current_tenant_id() and app.can_manage_registry()
         and client_id in (select app.accessible_client_ids()))
  with check (tenant_id = app.current_tenant_id());

grant select, insert, update on client, installation, eu_importer to cbam_app;

-- Assignments: client-level for every role except contributors, installation-level for
-- contributors. Admin assigns anyone; a consultant assigns reviewers/recipients to their
-- clients and contributors to their installations. The subquery on app_user runs under
-- app_user RLS, so only users visible to the caller can be assigned.
drop policy uca_read on user_client_assignment;
drop policy uca_write on user_client_assignment;
drop policy uia_read on user_installation_assignment;
drop policy uia_write on user_installation_assignment;

create policy uca_read on user_client_assignment for select to cbam_app
  using (tenant_id = app.current_tenant_id()
         and (user_id = app.current_user_id() or client_id in (select app.accessible_client_ids())));
create policy uca_insert on user_client_assignment for insert to cbam_app
  with check (
    tenant_id = app.current_tenant_id()
    and client_id in (select app.accessible_client_ids())
    and exists (
      select 1 from app_user u where u.id = user_id and u.role <> 'contributor'
         and (app.current_user_role() = 'platform_admin'
              or (app.current_user_role() = 'consultant' and u.role in ('reviewer', 'recipient')))));
create policy uca_delete on user_client_assignment for delete to cbam_app
  using (
    tenant_id = app.current_tenant_id()
    and client_id in (select app.accessible_client_ids())
    and (app.current_user_role() = 'platform_admin'
         or (app.current_user_role() = 'consultant'
             and exists (select 1 from app_user u where u.id = user_id and u.role in ('reviewer', 'recipient')))));

create policy uia_read on user_installation_assignment for select to cbam_app
  using (tenant_id = app.current_tenant_id()
         and (user_id = app.current_user_id() or installation_id in (select app.accessible_installation_ids())));
create policy uia_insert on user_installation_assignment for insert to cbam_app
  with check (
    tenant_id = app.current_tenant_id()
    and app.can_manage_registry()
    and installation_id in (select app.accessible_installation_ids())
    and exists (select 1 from app_user u where u.id = user_id and u.role = 'contributor'));
create policy uia_delete on user_installation_assignment for delete to cbam_app
  using (tenant_id = app.current_tenant_id() and app.can_manage_registry()
         and installation_id in (select app.accessible_installation_ids()));

-- Users on shared clients become visible (team lists, assignment pickers).
drop policy app_user_read on app_user;
create policy app_user_read on app_user for select to cbam_app
  using (
    tenant_id = app.current_tenant_id()
    and (
      app.current_user_role() = 'platform_admin'
      or id = app.current_user_id()
      or (app.current_user_role() = 'consultant' and created_by = app.current_user_id())
      or id in (select app.visible_user_ids())
    )
  );

-- migrate:down

drop policy app_user_read on app_user;
create policy app_user_read on app_user for select to cbam_app
  using (
    tenant_id = app.current_tenant_id()
    and (
      app.current_user_role() = 'platform_admin'
      or id = app.current_user_id()
      or (app.current_user_role() = 'consultant' and created_by = app.current_user_id())
    )
  );

drop policy uia_delete on user_installation_assignment;
drop policy uia_insert on user_installation_assignment;
drop policy uia_read on user_installation_assignment;
drop policy uca_delete on user_client_assignment;
drop policy uca_insert on user_client_assignment;
drop policy uca_read on user_client_assignment;
create policy uca_read on user_client_assignment for select to cbam_app
  using (tenant_id = app.current_tenant_id()
         and (app.current_user_role() = 'platform_admin' or user_id = app.current_user_id()));
create policy uca_write on user_client_assignment for all to cbam_app
  using (tenant_id = app.current_tenant_id() and app.current_user_role() = 'platform_admin')
  with check (tenant_id = app.current_tenant_id() and app.current_user_role() = 'platform_admin');
create policy uia_read on user_installation_assignment for select to cbam_app
  using (tenant_id = app.current_tenant_id()
         and (app.current_user_role() = 'platform_admin' or user_id = app.current_user_id()));
create policy uia_write on user_installation_assignment for all to cbam_app
  using (tenant_id = app.current_tenant_id() and app.current_user_role() = 'platform_admin')
  with check (tenant_id = app.current_tenant_id() and app.current_user_role() = 'platform_admin');

alter table user_installation_assignment drop constraint uia_installation_fk;
alter table user_client_assignment drop constraint uca_client_fk;

drop table eu_importer;
drop table installation;
drop table client;
drop function app.installation_visible(uuid, uuid);
drop function app.can_manage_registry();
drop function app.assign_client_creator();
drop function app.visible_user_ids();
drop function app.accessible_installation_ids();
drop function app.accessible_client_ids();
drop function app.forbid_client_change();
drop table ref_country;
revoke create on schema app from cbam_auth;
