-- migrate:up

-- Platform foundation: request context, row metadata, audit log (G3),
-- and a helper that registers a business table for audit + RLS (G1).
-- Tenant/client access helpers arrive with M1/M2; the period lock helper with M3.

create schema app authorization cbam_owner;
create schema audit authorization cbam_owner;

grant usage on schema public, app, audit to cbam_app;

-- ---------------------------------------------------------------------------
-- Request context. The API sets these per transaction with set_config(..., true).
-- ---------------------------------------------------------------------------

create function app.current_user_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create function app.current_tenant_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

create function app.current_user_role() returns text
  language sql stable
  as $$ select nullif(current_setting('app.user_role', true), '') $$;

-- ---------------------------------------------------------------------------
-- Row metadata: created_at/by on insert, updated_at/by on update.
-- created_* can never be changed after insert. Runs before RLS checks, so a write
-- without a request context fails here with a clear message.
-- ---------------------------------------------------------------------------

create function app.set_row_meta() returns trigger
  language plpgsql
  as $$
begin
  if app.current_user_id() is null then
    raise exception 'Write to %.% without a request context: app.user_id is not set',
      tg_table_schema, tg_table_name
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := app.current_user_id();
    new.updated_at := new.created_at;
    new.updated_by := new.created_by;
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.updated_at := now();
    new.updated_by := app.current_user_id();
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Audit log (G3, M13-R5, M13-R6). Append-only; written only by the trigger.
-- ---------------------------------------------------------------------------

create table audit.audit_log (
  id             bigint generated always as identity primary key,
  occurred_at    timestamptz not null default now(),
  tenant_id      uuid,
  client_id      uuid,
  actor_user_id  uuid not null,
  actor_role     text,
  action         text,                -- business verb set by the API, e.g. 'Approve period'
  op             text not null check (op in ('INSERT', 'UPDATE', 'DELETE')),
  table_name     text not null,
  record_id      text,
  old_row        jsonb,
  new_row        jsonb,
  changed_fields text[],
  request_id     text,
  reason         text
);

create index audit_log_tenant_client_time on audit.audit_log (tenant_id, client_id, occurred_at desc);
create index audit_log_record on audit.audit_log (table_name, record_id, occurred_at desc);
create index audit_log_actor_time on audit.audit_log (actor_user_id, occurred_at desc);

-- Trigger arguments: names of columns whose values must never be written to the log
-- (e.g. password_hash). A change to such a column is still logged, value redacted.
create function audit.log_row_change() returns trigger
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

create function audit.reject_change() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'audit.audit_log is append-only' using errcode = 'insufficient_privilege';
end
$$;

create trigger audit_log_no_update_delete
  before update or delete on audit.audit_log
  for each row execute function audit.reject_change();

create trigger audit_log_no_truncate
  before truncate on audit.audit_log
  for each statement execute function audit.reject_change();

-- The app role can only read the log; rows arrive through the security-definer trigger.
revoke all on audit.audit_log from public, cbam_app;
grant select on audit.audit_log to cbam_app;

alter table audit.audit_log enable row level security;
-- Tenant-level read for now; narrowed to client access when M2 adds app.can_access_client.
create policy audit_log_read on audit.audit_log
  for select to cbam_app
  using (tenant_id = app.current_tenant_id());

-- ---------------------------------------------------------------------------
-- Register a business table: row metadata, audit trigger, forced RLS.
-- Every module migration calls this for each table it creates.
-- The table must have id, created_at, created_by, updated_at, updated_by columns.
-- Policies and grants stay in the module migration, next to the table.
-- ---------------------------------------------------------------------------

create function app.register_business_table(p_table regclass, p_redact text[] default '{}')
  returns void
  language plpgsql
  as $$
begin
  execute format(
    'create trigger set_row_meta before insert or update on %s
       for each row execute function app.set_row_meta()', p_table);
  execute format(
    'create trigger audit_row_change after insert or update or delete on %s
       for each row execute function audit.log_row_change(%s)',
    p_table,
    coalesce((select string_agg(quote_literal(c), ', ') from unnest(p_redact) c), ''));
  execute format('alter table %s enable row level security', p_table);
  execute format('alter table %s force row level security', p_table);
end
$$;

revoke execute on function app.register_business_table(regclass, text[]) from public;

-- migrate:down

drop function app.register_business_table(regclass, text[]);
drop table audit.audit_log;
drop function audit.reject_change();
drop function audit.log_row_change();
drop function app.set_row_meta();
drop function app.current_user_role();
drop function app.current_tenant_id();
drop function app.current_user_id();
revoke usage on schema public, app, audit from cbam_app;
drop schema audit;
drop schema app;
