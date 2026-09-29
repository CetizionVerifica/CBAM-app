-- migrate:up

-- M3 — Reporting period manager. A reporting period belongs to one installation and holds
-- the dates (M3-R1, R2, R8). Each period has numbered data versions; status, the lock and
-- the pinned library and template versions live on the version (decision D2).
--
-- Status machine (M3-R3): draft → in_review → approved → issued. Back-transitions go only
-- to draft, only by a consultant, and need a reason. Approved and issued versions are
-- read-only (M3-R4, G4); an issued version never changes again, and later changes go into
-- version n+1 (M3-R5). Everything below is enforced here as well as in the API.

-- ---------------------------------------------------------------------------
-- reporting_period
-- ---------------------------------------------------------------------------

create table reporting_period (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  client_id        uuid not null,
  installation_id  uuid not null,
  start_date       date not null,
  end_date         date not null,
  -- M3-R2: required unless the period is a calendar year.
  justification    text check (length(justification) <= 2000),
  created_at       timestamptz not null,
  created_by       uuid not null,
  updated_at       timestamptz not null,
  updated_by       uuid not null,
  foreign key (installation_id, client_id, tenant_id) references installation (id, client_id, tenant_id),
  unique (id, installation_id, client_id, tenant_id),
  -- M3-R2: always 12 months. Same arithmetic as periodEndDate() in packages/shared.
  constraint reporting_period_twelve_months
    check (end_date = (start_date + interval '1 year' - interval '1 day')::date),
  constraint reporting_period_justified
    check ((extract(month from start_date) = 1 and extract(day from start_date) = 1)
           or length(btrim(coalesce(justification, ''))) > 0),
  -- M3-R1: no overlapping periods on the same installation. Bounds are inclusive dates.
  constraint reporting_period_no_overlap
    exclude using gist (installation_id with =, daterange(start_date, end_date, '[]') with &&)
);
select app.register_business_table('public.reporting_period');
create index reporting_period_installation on reporting_period (installation_id, start_date desc);

-- ---------------------------------------------------------------------------
-- period_version (decision D2). Version 1 opens with the period; n+1 only after n is issued.
-- ---------------------------------------------------------------------------

create table period_version (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  client_id            uuid not null,
  installation_id      uuid not null,
  period_id            uuid not null,
  version_no           integer not null check (version_no >= 1),
  status               text not null default 'draft'
                       check (status in ('draft', 'in_review', 'approved', 'issued')),
  -- G8: results store the library and template versions they used; the period pins them.
  library_version_id   uuid not null references library_version (id),
  template_version_id  uuid not null references template_version (id),
  based_on_version_id  uuid references period_version (id),
  approved_at          timestamptz,
  approved_by          uuid,
  issued_at            timestamptz,
  issued_by            uuid,
  created_at           timestamptz not null,
  created_by           uuid not null,
  updated_at           timestamptz not null,
  updated_by           uuid not null,
  foreign key (period_id, installation_id, client_id, tenant_id)
    references reporting_period (id, installation_id, client_id, tenant_id),
  unique (period_id, version_no),
  check ((status in ('approved', 'issued')) = (approved_at is not null)),
  check ((status = 'issued') = (issued_at is not null))
);
select app.register_business_table('public.period_version');
create index period_version_period on period_version (period_id, version_no desc);

-- ---------------------------------------------------------------------------
-- period_status_change: one row per status change, written by the trigger below (M3-R3).
-- ---------------------------------------------------------------------------

create table period_status_change (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  client_id          uuid not null,
  installation_id    uuid not null,
  period_version_id  uuid not null references period_version (id),
  from_status        text,  -- null when the version was created
  to_status          text not null,
  reason             text check (length(reason) <= 2000),
  created_at         timestamptz not null,
  created_by         uuid not null,
  updated_at         timestamptz not null,
  updated_by         uuid not null
);
select app.register_business_table('public.period_status_change');
create index period_status_change_version on period_status_change (period_version_id, created_at);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

-- Pinned library versions must be published: a draft library can still change (M4-R2).
create function app.assert_library_published(p_id uuid) returns void
  language plpgsql
  as $$
begin
  if not exists (select 1 from library_version where id = p_id and status = 'published') then
    raise exception 'A period can only pin a published library version'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

create function app.guard_period_version() returns trigger
  language plpgsql
  as $$
declare
  v_role   text := app.current_user_role();
  v_reason text := nullif(btrim(current_setting('app.reason', true)), '');
  v_prev   text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'A period version starts as a draft' using errcode = 'object_not_in_prerequisite_state';
    end if;
    new.approved_at := null; new.approved_by := null;
    new.issued_at := null;   new.issued_by := null;
    -- Versions are numbered 1, 2, 3…; a new one needs the previous one issued (M3-R5).
    -- FOR UPDATE serialises two concurrent "create new version" requests.
    perform 1 from reporting_period where id = new.period_id for update;
    select status into v_prev from period_version
     where period_id = new.period_id and version_no = new.version_no - 1;
    if new.version_no > 1 and v_prev is distinct from 'issued' then
      raise exception 'A new version needs the previous version to be issued'
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    if new.version_no = 1 and new.based_on_version_id is not null then
      raise exception 'Version 1 is not based on another version' using errcode = 'check_violation';
    end if;
    perform app.assert_library_published(new.library_version_id);
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'A period version cannot be deleted' using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- UPDATE
  if old.status = 'issued' then
    raise exception 'Version % of this period is issued and cannot be changed. Create a new version.', old.version_no
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (new.tenant_id, new.client_id, new.installation_id, new.period_id, new.version_no, new.based_on_version_id)
     is distinct from
     (old.tenant_id, old.client_id, old.installation_id, old.period_id, old.version_no, old.based_on_version_id) then
    raise exception 'A period version cannot be moved or renumbered' using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (new.library_version_id, new.template_version_id) is distinct from (old.library_version_id, old.template_version_id) then
    if old.status <> 'draft' then
      raise exception 'Pinned versions change only while the period is a draft'
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    perform app.assert_library_published(new.library_version_id);
  end if;

  if new.status is distinct from old.status then
    case
      when old.status = 'draft' and new.status = 'in_review' then
        if v_role not in ('platform_admin', 'consultant') then
          raise exception 'Your role cannot submit a period for review' using errcode = 'insufficient_privilege';
        end if;
      when old.status = 'in_review' and new.status = 'approved' then
        if v_role not in ('platform_admin', 'consultant', 'reviewer') then
          raise exception 'Your role cannot approve a period' using errcode = 'insufficient_privilege';
        end if;
        new.approved_at := now();
        new.approved_by := app.current_user_id();
      when old.status = 'approved' and new.status = 'issued' then
        if v_role not in ('platform_admin', 'consultant') then
          raise exception 'Your role cannot issue a period' using errcode = 'insufficient_privilege';
        end if;
        new.issued_at := now();
        new.issued_by := app.current_user_id();
      when old.status in ('in_review', 'approved') and new.status = 'draft' then
        -- M3-R3: back to draft only, only by a consultant, with a reason.
        if v_role is distinct from 'consultant' then
          raise exception 'Only a consultant can return a period to draft' using errcode = 'insufficient_privilege';
        end if;
        if v_reason is null then
          raise exception 'Returning a period to draft needs a reason' using errcode = 'check_violation';
        end if;
        new.approved_at := null;
        new.approved_by := null;
      else
        raise exception 'A period cannot go from % to %', old.status, new.status
          using errcode = 'object_not_in_prerequisite_state';
    end case;
  elsif old.status = 'approved' then
    raise exception 'This period is approved and read-only' using errcode = 'object_not_in_prerequisite_state';
  else
    -- approved_*/issued_* are set only by a status change.
    new.approved_at := old.approved_at; new.approved_by := old.approved_by;
    new.issued_at := old.issued_at;     new.issued_by := old.issued_by;
  end if;
  return new;
end
$$;
create trigger guard_period_version before insert or update or delete on period_version
  for each row execute function app.guard_period_version();

create function app.log_period_status() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into period_status_change
      (tenant_id, client_id, installation_id, period_version_id, from_status, to_status, reason)
    values
      (new.tenant_id, new.client_id, new.installation_id, new.id,
       case when tg_op = 'UPDATE' then old.status end, new.status,
       nullif(btrim(current_setting('app.reason', true)), ''));
  end if;
  return null;
end
$$;
create trigger log_period_status after insert or update on period_version
  for each row execute function app.log_period_status();

-- The history is append-only.
create function app.reject_history_change() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'The status history of a period cannot be changed' using errcode = 'object_not_in_prerequisite_state';
end
$$;
create trigger period_status_change_append_only before update or delete on period_status_change
  for each row execute function app.reject_history_change();

-- Dates are part of every version's data: they change only while the period has just its
-- first version, still in draft. The period never moves to another installation.
create function app.guard_reporting_period() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A reporting period cannot be deleted' using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (new.tenant_id, new.client_id, new.installation_id) is distinct from (old.tenant_id, old.client_id, old.installation_id) then
    raise exception 'A reporting period cannot be moved to another installation' using errcode = 'check_violation';
  end if;
  if (new.start_date, new.end_date, new.justification) is distinct from (old.start_date, old.end_date, old.justification)
     and exists (select 1 from period_version v
                  where v.period_id = old.id and (v.version_no > 1 or v.status <> 'draft')) then
    raise exception 'The dates of this period are locked' using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end
$$;
create trigger guard_reporting_period before update or delete on reporting_period
  for each row execute function app.guard_reporting_period();

-- M2-R6 / M2 AT3: an installation with reporting periods cannot be deleted.
create function app.guard_installation_delete() returns trigger
  language plpgsql
  as $$
begin
  if new.deleted_at is not null and old.deleted_at is null
     and exists (select 1 from reporting_period where installation_id = old.id) then
    raise exception 'An installation with reporting periods cannot be deleted' using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
create trigger installation_keep_with_periods before update of deleted_at on installation
  for each row execute function app.guard_installation_delete();

-- ---------------------------------------------------------------------------
-- The lock for period-scoped data (M3-R4, G4). Every later table that holds period data
-- (processes, source streams, energy, precursors…) has a period_version_id column and calls
-- app.register_period_table('<table>') in its migration. Writes to an approved or issued
-- version then fail with SQLSTATE 55000 (the API answers 409), whatever the API does.
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER (owned by cbam_auth, BYPASSRLS): row locks need the UPDATE policy,
-- which data contributors do not pass, but their writes must still be checked. It only
-- ever answers for the one version id it is given.
create function app.assert_period_writable(p_period_version_id uuid) returns void
  language plpgsql
  security definer
  set search_path = pg_catalog, public, pg_temp
  as $$
declare
  v_status text;
begin
  -- FOR SHARE: waits for a status change in progress, then sees the new status.
  select status into v_status from period_version where id = p_period_version_id for share;
  if v_status is null then
    raise exception 'Period version % does not exist', p_period_version_id using errcode = 'foreign_key_violation';
  end if;
  if v_status in ('approved', 'issued') then
    raise exception 'This period is % and read-only. Create a new version to make changes.', v_status
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

create function app.guard_period_scoped() returns trigger
  language plpgsql
  as $$
declare
  v_old uuid;
  v_new uuid;
begin
  if tg_op <> 'INSERT' then v_old := (to_jsonb(old) ->> 'period_version_id')::uuid; end if;
  if tg_op <> 'DELETE' then v_new := (to_jsonb(new) ->> 'period_version_id')::uuid; end if;
  if tg_op = 'UPDATE' and v_new is distinct from v_old then
    raise exception 'Period data cannot move to another period version' using errcode = 'object_not_in_prerequisite_state';
  end if;
  perform app.assert_period_writable(coalesce(v_new, v_old));
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

create function app.register_period_table(p_table regclass) returns void
  language plpgsql
  as $$
begin
  execute format(
    'create trigger guard_period_scoped before insert or update or delete on %s
       for each row execute function app.guard_period_scoped()', p_table);
end
$$;
revoke execute on function app.register_period_table(regclass) from public;

-- ---------------------------------------------------------------------------
-- Policies (G1, G2; decision D4). Everyone who sees the installation sees its periods.
-- Admins and consultants open periods and versions; reviewers also change status
-- (approve). Which transition each role may make is checked by the trigger above.
-- No DELETE grants.
-- ---------------------------------------------------------------------------

create policy reporting_period_read on reporting_period for select to cbam_app
  using (tenant_id = app.current_tenant_id() and app.installation_visible(client_id, installation_id));
create policy reporting_period_insert on reporting_period for insert to cbam_app
  with check (tenant_id = app.current_tenant_id() and app.can_manage_registry()
              and app.installation_visible(client_id, installation_id));
create policy reporting_period_update on reporting_period for update to cbam_app
  using (tenant_id = app.current_tenant_id() and app.can_manage_registry()
         and app.installation_visible(client_id, installation_id))
  with check (tenant_id = app.current_tenant_id());

create policy period_version_read on period_version for select to cbam_app
  using (tenant_id = app.current_tenant_id() and app.installation_visible(client_id, installation_id));
create policy period_version_insert on period_version for insert to cbam_app
  with check (tenant_id = app.current_tenant_id() and app.can_manage_registry()
              and app.installation_visible(client_id, installation_id));
create policy period_version_update on period_version for update to cbam_app
  using (tenant_id = app.current_tenant_id()
         and app.current_user_role() in ('platform_admin', 'consultant', 'reviewer')
         and app.installation_visible(client_id, installation_id))
  with check (tenant_id = app.current_tenant_id());

create policy period_status_change_read on period_status_change for select to cbam_app
  using (tenant_id = app.current_tenant_id() and app.installation_visible(client_id, installation_id));
-- Rows come from the status trigger, which runs as the acting user.
create policy period_status_change_insert on period_status_change for insert to cbam_app
  with check (tenant_id = app.current_tenant_id() and app.installation_visible(client_id, installation_id));

grant select, insert, update on reporting_period, period_version to cbam_app;
grant select, insert on period_status_change to cbam_app;

-- Privileges first, then ownership (see M1 migration: a non-owner's GRANT/REVOKE is skipped).
grant select, update on period_version to cbam_auth;  -- FOR SHARE needs UPDATE
revoke execute on function app.assert_period_writable(uuid) from public;
grant execute on function app.assert_period_writable(uuid) to cbam_app;
alter function app.assert_period_writable(uuid) owner to cbam_auth;

-- migrate:down

drop trigger installation_keep_with_periods on installation;
drop function app.guard_installation_delete();
drop table period_status_change;
revoke all on period_version from cbam_auth;
drop table period_version;
drop table reporting_period;
drop function app.register_period_table(regclass);
drop function app.guard_period_scoped();
drop function app.assert_period_writable(uuid);
drop function app.guard_reporting_period();
drop function app.reject_history_change();
drop function app.log_period_status();
drop function app.guard_period_version();
drop function app.assert_library_published(uuid);
