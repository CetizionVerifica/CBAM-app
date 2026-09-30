-- migrate:up

-- M13 — Evidence and audit.
--   evidence_document  one uploaded file (M13-R2, R3), owned by a client and optionally one installation
--   evidence_link      which records a file supports; one file, many records (M13-R1)
--   verification       verifier details, site visit, opinion and approvals, per period version (M13-R7)
-- and the audit trail read access for consultants and reviewers (M13-R5).

-- ---------------------------------------------------------------------------
-- Which tables evidence can be linked to. Configuration, not code: each later module that
-- adds a data table (processes, source streams…) inserts its table name here. The table
-- must have `id`, and `client_id` / `installation_id` / `period_version_id` where they apply.
-- ---------------------------------------------------------------------------

create table app.evidence_linkable (
  table_name  text primary key check (table_name ~ '^[a-z_][a-z0-9_]*$'),
  label       text not null
);
insert into app.evidence_linkable (table_name, label) values
  ('client', 'Client'),
  ('installation', 'Installation'),
  ('eu_importer', 'EU importer'),
  ('client_factor_override', 'Factor override'),
  ('period_version', 'Reporting period'),
  ('verification', 'Verification');
grant select on app.evidence_linkable to cbam_app;

-- ---------------------------------------------------------------------------
-- evidence_document
-- ---------------------------------------------------------------------------

create table evidence_document (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  client_id        uuid not null,
  -- Set when the file belongs to one site; then contributors of that site can see it (D4).
  installation_id  uuid,
  title            text not null check (length(btrim(title)) between 1 and 300),
  doc_type         text not null check (doc_type in
                     ('invoice', 'meter_reading', 'lab_report', 'contract', 'certificate', 'photo', 'other')),
  document_date    date,
  file_name        text not null check (length(btrim(file_name)) between 1 and 255),
  content_type     text not null check (content_type in
                     ('application/pdf', 'image/png', 'image/jpeg', 'text/csv',
                      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
  bytes            bigint not null check (bytes between 1 and 26214400),  -- 25 MB (M13-R3)
  sha256           char(64) not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key      text not null unique,
  deleted_at       timestamptz,
  created_at       timestamptz not null,
  created_by       uuid not null,
  updated_at       timestamptz not null,
  updated_by       uuid not null,
  foreign key (client_id, tenant_id) references client (id, tenant_id),
  foreign key (installation_id, client_id, tenant_id) references installation (id, client_id, tenant_id),
  unique (id, client_id, tenant_id)
);
select app.register_business_table('public.evidence_document');
create index evidence_document_client on evidence_document (client_id, created_at desc);
-- The same file twice for one client is a mistake; the API names the existing copy.
create unique index evidence_document_unique_file on evidence_document (client_id, sha256) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- evidence_link. installation_id and period_version_id are copied from the linked record by
-- the trigger below, never taken from the request.
-- ---------------------------------------------------------------------------

create table evidence_link (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  client_id          uuid not null,
  evidence_id        uuid not null,
  record_table       text not null references app.evidence_linkable (table_name),
  record_id          uuid not null,
  installation_id    uuid,
  period_version_id  uuid references period_version (id),
  created_at         timestamptz not null,
  created_by         uuid not null,
  updated_at         timestamptz not null,
  updated_by         uuid not null,
  foreign key (evidence_id, client_id, tenant_id) references evidence_document (id, client_id, tenant_id),
  unique (evidence_id, record_table, record_id)
);
select app.register_business_table('public.evidence_link');
create index evidence_link_record on evidence_link (record_table, record_id);
create index evidence_link_version on evidence_link (period_version_id) where period_version_id is not null;

-- Resolves the linked record (M13-R1). Runs as the caller, so a record they cannot see
-- (RLS) does not exist for them. Named to fire before the lock trigger below.
create function app.evidence_resolve_target() returns trigger
  language plpgsql
  as $$
declare
  v_row   jsonb;
  v_doc   record;
  v_inst  uuid;
begin
  if tg_op = 'UPDATE' then
    raise exception 'An evidence link cannot be changed; remove it and link again' using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- record_table is checked against app.evidence_linkable by the FK; quote it anyway.
  execute format('select to_jsonb(t) from public.%I t where id = $1', new.record_table) into v_row using new.record_id;
  if v_row is null or (v_row ->> 'deleted_at') is not null then
    raise exception 'The record to link does not exist' using errcode = 'foreign_key_violation';
  end if;
  if (case when new.record_table = 'client' then v_row ->> 'id' else v_row ->> 'client_id' end)::uuid
     is distinct from new.client_id then
    raise exception 'Evidence and record belong to different clients' using errcode = 'check_violation';
  end if;
  v_inst := (case when new.record_table = 'installation' then v_row ->> 'id' else v_row ->> 'installation_id' end)::uuid;
  select installation_id, deleted_at into v_doc from evidence_document where id = new.evidence_id;
  if v_doc.deleted_at is not null then
    raise exception 'This evidence has been deleted' using errcode = 'foreign_key_violation';
  end if;
  -- A file filed under one site supports only that site's records (or client-level ones).
  if v_doc.installation_id is not null and v_inst is not null and v_inst <> v_doc.installation_id then
    raise exception 'This evidence belongs to another installation' using errcode = 'check_violation';
  end if;
  new.installation_id := v_inst;
  new.period_version_id := (case when new.record_table = 'period_version' then v_row ->> 'id' else v_row ->> 'period_version_id' end)::uuid;
  return new;
end
$$;
create trigger evidence_resolve_target before insert or update on evidence_link
  for each row execute function app.evidence_resolve_target();

-- M13-R4, G4: links to records of an approved or issued version cannot be added or removed.
create function app.guard_evidence_link() returns trigger
  language plpgsql
  as $$
declare
  v_version uuid := case when tg_op = 'DELETE' then old.period_version_id else new.period_version_id end;
begin
  if v_version is not null then
    perform app.assert_period_writable(v_version);
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;
create trigger guard_evidence_link before insert or delete on evidence_link
  for each row execute function app.guard_evidence_link();

-- M13-R4: evidence supporting an approved or issued period is frozen: it cannot be renamed,
-- retyped or deleted. The file itself is never removed from storage (audit retention).
create function app.guard_evidence_document() returns trigger
  language plpgsql
  as $$
begin
  if (new.tenant_id, new.client_id, new.installation_id, new.file_name, new.content_type, new.bytes, new.sha256, new.storage_key)
     is distinct from
     (old.tenant_id, old.client_id, old.installation_id, old.file_name, old.content_type, old.bytes, old.sha256, old.storage_key) then
    raise exception 'The file of an evidence record cannot be changed; upload a new one' using errcode = 'object_not_in_prerequisite_state';
  end if;
  if old.deleted_at is not null then
    raise exception 'This evidence has been deleted' using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- SECURITY DEFINER lookup: the caller may not see every period the file supports.
  if app.evidence_is_locked(old.id) then
    raise exception 'This evidence supports an approved or issued period and cannot be changed or deleted'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end
$$;

create function app.evidence_is_locked(p_evidence_id uuid) returns boolean
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp
  as $$
    select exists (
      select 1 from evidence_link l join period_version v on v.id = l.period_version_id
       where l.evidence_id = p_evidence_id and v.status in ('approved', 'issued')
         and l.tenant_id = app.current_tenant_id())
  $$;

create trigger guard_evidence_document before update or delete on evidence_document
  for each row execute function app.guard_evidence_document();

-- ---------------------------------------------------------------------------
-- verification (M13-R7). One per period version; fields follow template sheet A section 3
-- (docs/mappings/template-A_InstData.md, I37–I53). Period data, so it locks with the period.
-- ---------------------------------------------------------------------------

create table verification (
  id                          uuid primary key default gen_random_uuid(),
  tenant_id                   uuid not null,
  client_id                   uuid not null,
  installation_id             uuid not null,
  period_version_id           uuid not null unique references period_version (id),
  verifier_name               text check (length(verifier_name) <= 300),                 -- I37
  verifier_street             text check (length(verifier_street) <= 300),               -- I38
  verifier_city               text check (length(verifier_city) <= 200),                 -- I39
  verifier_postcode           text check (length(verifier_postcode) <= 40),              -- I40
  verifier_country_code       char(2) references ref_country (code),                     -- I41 (as name)
  rep_name                    text check (length(rep_name) <= 200),                      -- I45
  rep_email                   citext check (rep_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),   -- I46
  rep_phone                   text check (length(rep_phone) <= 50),                      -- I47
  rep_fax                     text check (length(rep_fax) <= 50),                        -- I48
  accreditation_member_state  char(2) references ref_country (code),                     -- I51 (as name)
  accreditation_body          text check (length(accreditation_body) <= 300),            -- I52
  accreditation_reg_no        text check (length(accreditation_reg_no) <= 100),          -- I53
  site_visit_date             date,
  opinion                     text check (length(opinion) <= 10000),
  findings                    text[] not null default '{}'
                              check (cardinality(findings) <= 200),
  consultant_approved_at      timestamptz,
  consultant_approved_by      uuid,
  client_approved_at          timestamptz,
  client_approved_by          uuid,
  created_at                  timestamptz not null,
  created_by                  uuid not null,
  updated_at                  timestamptz not null,
  updated_by                  uuid not null,
  foreign key (installation_id, client_id, tenant_id) references installation (id, client_id, tenant_id),
  check ((consultant_approved_at is null) = (consultant_approved_by is null)),
  check ((client_approved_at is null) = (client_approved_by is null))
);
select app.register_business_table('public.verification');
select app.register_period_table('public.verification');

-- Who may change what (G2), and approvals (spec 4.10: "approval by consultant and client").
-- Any change to the verification data withdraws both approvals, so an approval always
-- covers what is on record now.
create function app.guard_verification() returns trigger
  language plpgsql
  as $$
declare
  v_role text := app.current_user_role();
  v_data_changed boolean;
begin
  if tg_op = 'INSERT' then
    if v_role not in ('platform_admin', 'consultant', 'reviewer') then
      raise exception 'Your role cannot record verification details' using errcode = 'insufficient_privilege';
    end if;
    if not exists (select 1 from period_version v
                    where v.id = new.period_version_id and v.installation_id = new.installation_id
                      and v.client_id = new.client_id and v.tenant_id = new.tenant_id) then
      raise exception 'Verification must match its period' using errcode = 'check_violation';
    end if;
    new.consultant_approved_at := null; new.consultant_approved_by := null;
    new.client_approved_at := null;     new.client_approved_by := null;
    return new;
  end if;
  if (new.tenant_id, new.client_id, new.installation_id, new.period_version_id)
     is distinct from (old.tenant_id, old.client_id, old.installation_id, old.period_version_id) then
    raise exception 'Verification cannot move to another period' using errcode = 'check_violation';
  end if;

  v_data_changed := (to_jsonb(new) - array['consultant_approved_at', 'consultant_approved_by', 'client_approved_at',
                                           'client_approved_by', 'updated_at', 'updated_by'])
                    is distinct from
                    (to_jsonb(old) - array['consultant_approved_at', 'consultant_approved_by', 'client_approved_at',
                                           'client_approved_by', 'updated_at', 'updated_by']);
  if v_data_changed then
    if v_role not in ('platform_admin', 'consultant', 'reviewer') then
      raise exception 'Your role cannot change verification details' using errcode = 'insufficient_privilege';
    end if;
    new.consultant_approved_at := null; new.consultant_approved_by := null;
    new.client_approved_at := null;     new.client_approved_by := null;
    return new;
  end if;

  if new.consultant_approved_at is distinct from old.consultant_approved_at then
    if v_role not in ('platform_admin', 'consultant') then
      raise exception 'Only a consultant can give the consultant approval' using errcode = 'insufficient_privilege';
    end if;
    new.consultant_approved_at := case when new.consultant_approved_at is null then null else now() end;
    new.consultant_approved_by := case when new.consultant_approved_at is null then null else app.current_user_id() end;
  else
    new.consultant_approved_by := old.consultant_approved_by;
  end if;
  if new.client_approved_at is distinct from old.client_approved_at then
    -- Client-side users: plant staff (contributor) or client management (recipient).
    if v_role not in ('contributor', 'recipient') then
      raise exception 'Only a client user can give the client approval' using errcode = 'insufficient_privilege';
    end if;
    new.client_approved_at := case when new.client_approved_at is null then null else now() end;
    new.client_approved_by := case when new.client_approved_at is null then null else app.current_user_id() end;
  else
    new.client_approved_by := old.client_approved_by;
  end if;
  return new;
end
$$;
create trigger guard_verification before insert or update on verification
  for each row execute function app.guard_verification();

-- ---------------------------------------------------------------------------
-- Policies (G1, G2; decision D4). Recipients see approved outputs only (M12), not evidence.
-- Contributors see files of their installations; client-level files are for the other roles.
-- ---------------------------------------------------------------------------

create function app.evidence_visible(p_client_id uuid, p_installation_id uuid) returns boolean
  language sql stable
  as $$
    select app.current_user_role() <> 'recipient'
       and p_client_id in (select app.accessible_client_ids())
       and case when p_installation_id is null then app.current_user_role() <> 'contributor'
                else app.installation_visible(p_client_id, p_installation_id) end
  $$;

create function app.can_upload_evidence() returns boolean
  language sql stable
  as $$ select app.current_user_role() in ('platform_admin', 'consultant', 'contributor') $$;

create policy evidence_document_read on evidence_document for select to cbam_app
  using (tenant_id = app.current_tenant_id() and app.evidence_visible(client_id, installation_id));
create policy evidence_document_insert on evidence_document for insert to cbam_app
  with check (tenant_id = app.current_tenant_id() and app.can_upload_evidence()
              and app.evidence_visible(client_id, installation_id));
-- Admins and consultants edit and delete any file; contributors only their own uploads.
create policy evidence_document_update on evidence_document for update to cbam_app
  using (tenant_id = app.current_tenant_id() and app.evidence_visible(client_id, installation_id)
         and (app.can_manage_registry() or (app.current_user_role() = 'contributor' and created_by = app.current_user_id())))
  with check (tenant_id = app.current_tenant_id());

create policy evidence_link_read on evidence_link for select to cbam_app
  using (tenant_id = app.current_tenant_id() and app.evidence_visible(client_id, installation_id));
create policy evidence_link_insert on evidence_link for insert to cbam_app
  with check (tenant_id = app.current_tenant_id() and app.can_upload_evidence()
              and app.evidence_visible(client_id, installation_id));
create policy evidence_link_delete on evidence_link for delete to cbam_app
  using (tenant_id = app.current_tenant_id() and app.can_upload_evidence()
         and app.evidence_visible(client_id, installation_id));

create policy verification_read on verification for select to cbam_app
  using (tenant_id = app.current_tenant_id() and app.installation_visible(client_id, installation_id));
create policy verification_insert on verification for insert to cbam_app
  with check (tenant_id = app.current_tenant_id() and app.installation_visible(client_id, installation_id));
create policy verification_update on verification for update to cbam_app
  using (tenant_id = app.current_tenant_id() and app.installation_visible(client_id, installation_id))
  with check (tenant_id = app.current_tenant_id());

grant select, insert, update on evidence_document, verification to cbam_app;
grant select, insert, delete on evidence_link to cbam_app;

-- evidence_is_locked must see every link and version, whatever the caller can see.
grant select on evidence_link to cbam_auth;
revoke execute on function app.evidence_is_locked(uuid) from public;
grant execute on function app.evidence_is_locked(uuid) to cbam_app;
alter function app.evidence_is_locked(uuid) owner to cbam_auth;

-- ---------------------------------------------------------------------------
-- Audit trail readers (M13-R5). The admin reads the whole tenant; consultants and reviewers
-- read entries of the clients they are assigned to. Entries without a client (users,
-- library) stay admin-only. Contributors and recipients have no audit trail access.
-- ---------------------------------------------------------------------------

drop policy audit_log_read on audit.audit_log;
create policy audit_log_read on audit.audit_log for select to cbam_app
  using (tenant_id = app.current_tenant_id()
         and (app.current_user_role() = 'platform_admin'
              or (app.current_user_role() in ('consultant', 'reviewer')
                  and client_id in (select app.accessible_client_ids()))));
create index audit_log_tenant_time on audit.audit_log (tenant_id, occurred_at desc, id desc);

-- migrate:down

drop index audit.audit_log_tenant_time;
drop policy audit_log_read on audit.audit_log;
create policy audit_log_read on audit.audit_log for select to cbam_app
  using (tenant_id = app.current_tenant_id() and app.current_user_role() = 'platform_admin');

revoke all on evidence_link from cbam_auth;
drop table verification;
drop table evidence_link;
drop table evidence_document;
drop function app.guard_verification();
drop function app.guard_evidence_document();
drop function app.evidence_is_locked(uuid);
drop function app.guard_evidence_link();
drop function app.evidence_resolve_target();
drop function app.can_upload_evidence();
drop function app.evidence_visible(uuid, uuid);
drop table app.evidence_linkable;
