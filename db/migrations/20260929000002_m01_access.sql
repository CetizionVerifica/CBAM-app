-- migrate:up

-- M1 — Tenant and access.
-- Business tables (audited, RLS): tenant, app_user, invitation, user_client_assignment,
-- user_installation_assignment. Auth internals live in schema auth, are not granted to
-- cbam_app, and are reached only through the SECURITY DEFINER functions below, owned by
-- cbam_auth (BYPASSRLS) because they run before a request context exists.
-- Decision D1: these tables carry tenant_id only; users are not scoped to one client.

-- Metadata columns also get defaults so generated types mark them as optional on insert;
-- the set_row_meta trigger still decides the values.
create or replace function app.register_business_table(p_table regclass, p_redact text[] default '{}')
  returns void
  language plpgsql
  as $$
begin
  execute format(
    'alter table %s
       alter column created_at set default now(),
       alter column created_by set default app.current_user_id(),
       alter column updated_at set default now(),
       alter column updated_by set default app.current_user_id()', p_table);
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

create schema auth authorization cbam_owner;
grant usage on schema auth to cbam_app;
grant usage on schema public, app, audit, auth to cbam_auth;
grant create on schema auth to cbam_auth;  -- required to own the functions in it

-- M1-R1, decision D5: one role per user.
create type user_role as enum ('platform_admin', 'consultant', 'contributor', 'reviewer', 'recipient');
create type user_status as enum ('invited', 'active', 'deactivated');

-- ---------------------------------------------------------------------------
-- tenant
-- ---------------------------------------------------------------------------

create table tenant (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) between 1 and 200),
  slug       text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  settings   jsonb not null default '{}',
  created_at timestamptz not null,
  created_by uuid not null,
  updated_at timestamptz not null,
  updated_by uuid not null
);
select app.register_business_table('public.tenant');

create policy tenant_read on tenant for select to cbam_app
  using (id = app.current_tenant_id());
grant select on tenant to cbam_app;

-- ---------------------------------------------------------------------------
-- app_user (M1-R1, M1-R2)
-- ---------------------------------------------------------------------------

create table app_user (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant (id),
  email           citext not null unique check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  display_name    text not null check (length(btrim(display_name)) between 1 and 200),
  role            user_role not null,
  status          user_status not null default 'invited',
  password_hash   text,
  totp_secret_enc text,
  totp_enabled_at timestamptz,
  deactivated_at  timestamptz,
  created_at      timestamptz not null,
  created_by      uuid not null,
  updated_at      timestamptz not null,
  updated_by      uuid not null,
  unique (id, tenant_id),
  check (status <> 'active' or password_hash is not null),
  check ((status = 'deactivated') = (deactivated_at is not null)),
  check (totp_enabled_at is null or totp_secret_enc is not null)
);
select app.register_business_table('public.app_user', '{password_hash,totp_secret_enc}');

-- Roles a consultant may invite; admins may invite any role.
create function app.consultant_can_manage_role(r user_role) returns boolean
  language sql immutable
  as $$ select r in ('contributor', 'reviewer', 'recipient') $$;

-- Admin sees every user in the tenant; others see themselves, and consultants the users
-- they invited. M2 widens this to users sharing an assigned client.
create policy app_user_read on app_user for select to cbam_app
  using (
    tenant_id = app.current_tenant_id()
    and (
      app.current_user_role() = 'platform_admin'
      or id = app.current_user_id()
      or (app.current_user_role() = 'consultant' and created_by = app.current_user_id())
    )
  );

create policy app_user_insert on app_user for insert to cbam_app
  with check (
    tenant_id = app.current_tenant_id()
    and status = 'invited'
    and password_hash is null
    and totp_secret_enc is null
    and (
      app.current_user_role() = 'platform_admin'
      or (app.current_user_role() = 'consultant' and app.consultant_can_manage_role(role))
    )
  );

-- Only admins change users through the API (role, name, status). Self-service changes
-- (password on invite, 2FA) go through the auth functions.
create policy app_user_update on app_user for update to cbam_app
  using (tenant_id = app.current_tenant_id() and app.current_user_role() = 'platform_admin')
  with check (tenant_id = app.current_tenant_id());

grant select, insert, update on app_user to cbam_app;

-- ---------------------------------------------------------------------------
-- invitation (M1-R4). Only the SHA-256 of the token is stored.
-- ---------------------------------------------------------------------------

create table invitation (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  user_id    uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at    timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null,
  created_by uuid not null,
  updated_at timestamptz not null,
  updated_by uuid not null,
  foreign key (user_id, tenant_id) references app_user (id, tenant_id),
  check (expires_at > created_at),
  check (used_at is null or revoked_at is null)
);
select app.register_business_table('public.invitation', '{token_hash}');
create index invitation_user on invitation (user_id);
-- At most one open invitation per user.
create unique index invitation_one_open on invitation (user_id) where used_at is null and revoked_at is null;

create policy invitation_access on invitation for all to cbam_app
  using (
    tenant_id = app.current_tenant_id()
    and (app.current_user_role() = 'platform_admin'
         or (app.current_user_role() = 'consultant' and created_by = app.current_user_id()))
  )
  -- The target user must be one the caller may manage (review M1 F3): an admin manages
  -- anyone in the tenant; a consultant only client-side users they invited. The subquery
  -- runs under app_user's own RLS, so invisible users never match.
  with check (
    tenant_id = app.current_tenant_id()
    and exists (
      select 1 from app_user u
       where u.id = invitation.user_id
         and u.tenant_id = invitation.tenant_id
         and (app.current_user_role() = 'platform_admin'
              or (app.current_user_role() = 'consultant'
                  and u.created_by = app.current_user_id()
                  and app.consultant_can_manage_role(u.role)))
    )
  );
grant select, insert, update on invitation to cbam_app;

-- ---------------------------------------------------------------------------
-- Assignments (M1-R2). FKs to client and installation are added by M2.
-- ---------------------------------------------------------------------------

create table user_client_assignment (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  user_id    uuid not null,
  client_id  uuid not null,
  created_at timestamptz not null,
  created_by uuid not null,
  updated_at timestamptz not null,
  updated_by uuid not null,
  foreign key (user_id, tenant_id) references app_user (id, tenant_id),
  unique (user_id, client_id)
);
select app.register_business_table('public.user_client_assignment');
create index user_client_assignment_client on user_client_assignment (client_id);

create table user_installation_assignment (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  client_id       uuid not null,
  user_id         uuid not null,
  installation_id uuid not null,
  created_at      timestamptz not null,
  created_by      uuid not null,
  updated_at      timestamptz not null,
  updated_by      uuid not null,
  foreign key (user_id, tenant_id) references app_user (id, tenant_id),
  unique (user_id, installation_id)
);
select app.register_business_table('public.user_installation_assignment');
create index user_installation_assignment_installation on user_installation_assignment (installation_id);

-- Read own assignments; admin reads and writes all. M2 lets consultants manage their clients'.
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
grant select, insert, delete on user_client_assignment, user_installation_assignment to cbam_app;

-- ---------------------------------------------------------------------------
-- Auth internals (schema auth). Not business data; login activity is in auth_event.
-- ---------------------------------------------------------------------------

create table auth.login_state (
  user_id       uuid primary key references app_user (id),
  failed_count  int not null default 0 check (failed_count >= 0),
  locked_until  timestamptz,
  last_login_at timestamptz,
  -- Last accepted TOTP time step; a code at or before it is a replay (review M1 F7).
  totp_last_step bigint
);

create table auth.session (
  id_hash         text primary key check (id_hash ~ '^[0-9a-f]{64}$'),
  user_id         uuid not null references app_user (id),
  tenant_id       uuid not null references tenant (id),
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  expires_at      timestamptz not null,
  mfa_verified_at timestamptz,
  revoked_at      timestamptz,
  ip              text,
  user_agent      text
);
create index session_user_active on auth.session (user_id) where revoked_at is null;

create table auth.mfa_recovery_code (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references app_user (id),
  code_hash  text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  used_at    timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, code_hash)
);

create table auth.auth_event (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  tenant_id   uuid,
  user_id     uuid,
  email       citext,
  event       text not null,
  ip          text,
  user_agent  text,
  detail      jsonb
);
create index auth_event_user_time on auth.auth_event (user_id, occurred_at desc);
create trigger auth_event_no_update_delete before update or delete on auth.auth_event
  for each row execute function audit.reject_change();
create trigger auth_event_no_truncate before truncate on auth.auth_event
  for each statement execute function audit.reject_change();

revoke all on all tables in schema auth from public, cbam_app;
grant select, insert, update on auth.login_state, auth.session, auth.mfa_recovery_code to cbam_auth;
grant delete on auth.mfa_recovery_code to cbam_auth;
grant insert on auth.auth_event to cbam_auth;
grant select, insert, update on tenant, app_user, invitation to cbam_auth;

-- ---------------------------------------------------------------------------
-- Auth functions. Each is SECURITY DEFINER, owned by cbam_auth, with a fixed search_path.
-- Writes to audited tables set the request context to the acting user first.
-- ---------------------------------------------------------------------------

create function auth.act_as(p_user_id uuid, p_action text) returns void
  language plpgsql
  set search_path = pg_catalog, public, pg_temp
  as $$
declare
  v_tenant uuid;
  v_role   user_role;
begin
  select tenant_id, role into v_tenant, v_role from app_user where id = p_user_id;
  perform set_config('app.user_id', p_user_id::text, true);
  perform set_config('app.tenant_id', v_tenant::text, true);
  perform set_config('app.user_role', v_role::text, true);
  perform set_config('app.action', p_action, true);
end
$$;

-- Everything the login step needs, by email. Unknown email returns no row.
create function auth.login_lookup(p_email text)
  returns table (user_id uuid, tenant_id uuid, role user_role, status user_status,
                 password_hash text, totp_enabled boolean, locked_until timestamptz)
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp
  as $$
    select u.id, u.tenant_id, u.role, u.status, u.password_hash,
           u.totp_enabled_at is not null, ls.locked_until
      from app_user u
      left join auth.login_state ls on ls.user_id = u.id
     where u.email = p_email::citext
  $$;

-- Counts a failed password or 2FA attempt; locks the account at p_max (M1-R6).
create function auth.record_login_failure(p_user_id uuid, p_max int, p_lock_minutes int)
  returns timestamptz
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp
  as $$
declare
  v_locked timestamptz;
begin
  insert into auth.login_state as ls (user_id, failed_count)
  values (p_user_id, 1)
  on conflict (user_id) do update set failed_count = ls.failed_count + 1;

  update auth.login_state
     set locked_until = now() + make_interval(mins => p_lock_minutes), failed_count = 0
   where user_id = p_user_id and failed_count >= p_max
  returning locked_until into v_locked;
  -- On lock, every session still waiting for its second factor ends (review M1 F2).
  if v_locked is not null then
    update auth.session set revoked_at = now()
     where user_id = p_user_id and revoked_at is null and mfa_verified_at is null;
  end if;
  return v_locked;
end
$$;

-- Only a completed sign-in clears failures: password alone when the user has no 2FA,
-- otherwise the second factor (review M1 F1). Internal; not granted to cbam_app.
create function auth.clear_login_failures(p_user_id uuid) returns void
  language sql
  set search_path = pg_catalog, public, pg_temp
  as $$
    update auth.login_state set failed_count = 0, locked_until = null, last_login_at = now()
     where user_id = p_user_id
  $$;

create function auth.is_locked(p_user_id uuid) returns boolean
  language sql stable
  set search_path = pg_catalog, public, pg_temp
  as $$ select coalesce((select locked_until > now() from auth.login_state where user_id = p_user_id), false) $$;

create function auth.create_session(p_user_id uuid, p_id_hash text, p_ttl_minutes int,
                                    p_ip text, p_user_agent text, p_fully_authenticated boolean)
  returns void
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp
  as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from app_user where id = p_user_id and status = 'active';
  if v_tenant is null then
    raise exception 'User is not active' using errcode = 'insufficient_privilege';
  end if;
  insert into auth.session (id_hash, user_id, tenant_id, expires_at, ip, user_agent)
  values (p_id_hash, p_user_id, v_tenant, now() + make_interval(mins => p_ttl_minutes), p_ip, p_user_agent);
  insert into auth.login_state (user_id) values (p_user_id) on conflict (user_id) do nothing;
  if p_fully_authenticated then
    perform auth.clear_login_failures(p_user_id);
  end if;
end
$$;

-- Resolves a session cookie. Revoked, expired, idle or deactivated → no row (M1-R7).
create function auth.session_lookup(p_id_hash text, p_idle_minutes int)
  returns table (user_id uuid, tenant_id uuid, role user_role, email text, display_name text,
                 mfa_verified boolean, totp_enabled boolean, expires_at timestamptz, locked boolean)
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp
  as $$
begin
  return query
  update auth.session s
     set last_seen_at = now()
    from app_user u
   where s.id_hash = p_id_hash
     and u.id = s.user_id
     and u.status = 'active'
     and s.revoked_at is null
     and s.expires_at > now()
     and s.last_seen_at > now() - make_interval(mins => p_idle_minutes)
  returning u.id, u.tenant_id, u.role, u.email::text, u.display_name,
            s.mfa_verified_at is not null, u.totp_enabled_at is not null, s.expires_at,
            auth.is_locked(u.id);
end
$$;

create function auth.revoke_session(p_id_hash text) returns void
  language sql security definer
  set search_path = pg_catalog, public, pg_temp
  as $$ update auth.session set revoked_at = now() where id_hash = p_id_hash and revoked_at is null $$;

-- Called by the admin deactivating a user (M1-R7), or by users for themselves.
create function auth.revoke_user_sessions(p_user_id uuid) returns int
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp
  as $$
declare
  v_count int;
begin
  if not (
    p_user_id = app.current_user_id()
    or (app.current_user_role() = 'platform_admin'
        and exists (select 1 from app_user where id = p_user_id and tenant_id = app.current_tenant_id()))
  ) then
    raise exception 'Not allowed to revoke sessions for this user' using errcode = 'insufficient_privilege';
  end if;
  update auth.session set revoked_at = now() where user_id = p_user_id and revoked_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- 2FA (M1-R5). All keyed by the caller's own session, never by a user id from the request.

create function auth.session_user(p_id_hash text) returns uuid
  language sql stable
  set search_path = pg_catalog, public, pg_temp
  as $$
    select s.user_id from auth.session s join app_user u on u.id = s.user_id
     where s.id_hash = p_id_hash and s.revoked_at is null and s.expires_at > now() and u.status = 'active'
  $$;

create function auth.get_totp_secret(p_id_hash text) returns text
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp
  as $$ select totp_secret_enc from app_user where id = auth.session_user(p_id_hash) $$;

-- Stores a pending secret during set-up; refused once 2FA is enabled.
create function auth.set_pending_totp_secret(p_id_hash text, p_secret_enc text) returns void
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp
  as $$
declare
  v_user uuid := auth.session_user(p_id_hash);
begin
  if v_user is null then raise exception 'Session not valid' using errcode = 'insufficient_privilege'; end if;
  perform auth.act_as(v_user, 'Start two-factor set-up');
  update app_user set totp_secret_enc = p_secret_enc where id = v_user and totp_enabled_at is null;
  if not found then
    raise exception 'Two-factor authentication is already enabled' using errcode = 'check_violation';
  end if;
end
$$;

create function auth.enable_totp(p_id_hash text, p_recovery_code_hashes text[], p_step bigint) returns void
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp
  as $$
declare
  v_user uuid := auth.session_user(p_id_hash);
begin
  if v_user is null then raise exception 'Session not valid' using errcode = 'insufficient_privilege'; end if;
  perform auth.act_as(v_user, 'Turn on two-factor authentication');
  update app_user set totp_enabled_at = now()
   where id = v_user and totp_enabled_at is null and totp_secret_enc is not null;
  if not found then
    raise exception 'No pending two-factor set-up' using errcode = 'check_violation';
  end if;
  delete from auth.mfa_recovery_code where user_id = v_user;
  insert into auth.mfa_recovery_code (user_id, code_hash) select v_user, unnest(p_recovery_code_hashes);
  update auth.session set mfa_verified_at = now() where id_hash = p_id_hash;
  update auth.login_state set totp_last_step = p_step where user_id = v_user;
  perform auth.clear_login_failures(v_user);
end
$$;

-- Accepts a verified TOTP step once: refused while locked or for a step already used
-- (review M1 F2, F7). Returns false when refused.
create function auth.mark_session_mfa_verified(p_id_hash text, p_step bigint) returns boolean
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp
  as $$
declare
  v_user uuid := auth.session_user(p_id_hash);
begin
  if v_user is null or auth.is_locked(v_user) then return false; end if;
  update auth.login_state set totp_last_step = p_step
   where user_id = v_user and (totp_last_step is null or totp_last_step < p_step);
  if not found then return false; end if;
  update auth.session set mfa_verified_at = now() where id_hash = p_id_hash;
  perform auth.clear_login_failures(v_user);
  return true;
end
$$;

create function auth.use_recovery_code(p_id_hash text, p_code_hash text) returns boolean
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp
  as $$
declare
  v_user uuid := auth.session_user(p_id_hash);
begin
  if v_user is null or auth.is_locked(v_user) then return false; end if;
  update auth.mfa_recovery_code set used_at = now()
   where user_id = v_user and code_hash = p_code_hash and used_at is null;
  if not found then return false; end if;
  update auth.session set mfa_verified_at = now() where id_hash = p_id_hash;
  perform auth.clear_login_failures(v_user);
  return true;
end
$$;

create function auth.log_event(p_tenant_id uuid, p_user_id uuid, p_email text, p_event text,
                               p_ip text, p_user_agent text, p_detail jsonb default null)
  returns void
  language sql security definer
  set search_path = pg_catalog, public, pg_temp
  as $$
    insert into auth.auth_event (tenant_id, user_id, email, event, ip, user_agent, detail)
    values (p_tenant_id, p_user_id, p_email::citext, p_event, p_ip, p_user_agent, p_detail)
  $$;

-- Invitations (M1-R4).

create function auth.invitation_lookup(p_token_hash text)
  returns table (email text, display_name text, role user_role, tenant_name text, expires_at timestamptz)
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp
  as $$
    select u.email::text, u.display_name, u.role, t.name, i.expires_at
      from invitation i
      join app_user u on u.id = i.user_id
      join tenant t on t.id = i.tenant_id
     where i.token_hash = p_token_hash
       and i.used_at is null and i.revoked_at is null and i.expires_at > now()
       and u.status = 'invited'
  $$;

-- Single use is atomic: the first UPDATE to mark the invitation used wins (M1 AT4).
create function auth.accept_invitation(p_token_hash text, p_display_name text, p_password_hash text)
  returns uuid
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp
  as $$
declare
  v_user uuid;
begin
  select i.user_id into v_user
    from invitation i join app_user u on u.id = i.user_id
   where i.token_hash = p_token_hash
     and i.used_at is null and i.revoked_at is null and i.expires_at > now()
     and u.status = 'invited'
   for update of i;
  if v_user is null then
    raise exception 'Invitation is not valid' using errcode = 'no_data_found';
  end if;
  perform auth.act_as(v_user, 'Accept invitation');
  update invitation set used_at = now() where token_hash = p_token_hash;
  update app_user
     set status = 'active', password_hash = p_password_hash, display_name = p_display_name
   where id = v_user;
  return v_user;
end
$$;

-- First tenant and its platform admin. Only the owner role can call it (CLI bootstrap).
create function auth.bootstrap_tenant(p_name text, p_slug text, p_email text, p_display_name text,
                                      p_token_hash text, p_expires_at timestamptz)
  returns table (tenant_id uuid, user_id uuid)
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp
  as $$
declare
  v_tenant uuid := gen_random_uuid();
  v_user   uuid := gen_random_uuid();
begin
  perform set_config('app.user_id', v_user::text, true);
  perform set_config('app.tenant_id', v_tenant::text, true);
  perform set_config('app.user_role', 'platform_admin', true);
  perform set_config('app.action', 'Create tenant', true);
  insert into tenant (id, name, slug) values (v_tenant, p_name, p_slug);
  insert into app_user (id, tenant_id, email, display_name, role)
  values (v_user, v_tenant, p_email, p_display_name, 'platform_admin');
  insert into invitation (tenant_id, user_id, token_hash, expires_at)
  values (v_tenant, v_user, p_token_hash, p_expires_at);
  return query select v_tenant, v_user;
end
$$;

-- Execute rights, then ownership. Order matters: privileges must be set while cbam_owner
-- still owns the functions (a non-owner's REVOKE/GRANT is silently skipped), and they
-- carry over to cbam_auth on ALTER OWNER.
revoke execute on all functions in schema auth from public;

grant execute on function
  auth.login_lookup(text),
  auth.record_login_failure(uuid, int, int),
  auth.create_session(uuid, text, int, text, text, boolean),
  auth.session_lookup(text, int),
  auth.revoke_session(text),
  auth.revoke_user_sessions(uuid),
  auth.get_totp_secret(text),
  auth.set_pending_totp_secret(text, text),
  auth.enable_totp(text, text[], bigint),
  auth.mark_session_mfa_verified(text, bigint),
  auth.use_recovery_code(text, text),
  auth.log_event(uuid, uuid, text, text, text, text, jsonb),
  auth.invitation_lookup(text),
  auth.accept_invitation(text, text, text)
to cbam_app;

do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'auth'
  loop
    execute format('alter function %s owner to cbam_auth', f);
  end loop;
end
$$;

-- The CLI bootstrap runs as cbam_owner. Granted by the new owner: a grant from cbam_owner
-- to itself would have been folded into owner rights and passed on with ownership.
set local role cbam_auth;
grant execute on function auth.bootstrap_tenant(text, text, text, text, text, timestamptz) to cbam_owner;
reset role;

-- Audit trail readers: narrow to the tenant's admin until M2 adds client access.
drop policy audit_log_read on audit.audit_log;
create policy audit_log_read on audit.audit_log for select to cbam_app
  using (tenant_id = app.current_tenant_id() and app.current_user_role() = 'platform_admin');

-- migrate:down

drop policy audit_log_read on audit.audit_log;
create policy audit_log_read on audit.audit_log for select to cbam_app
  using (tenant_id = app.current_tenant_id());

drop function auth.bootstrap_tenant(text, text, text, text, text, timestamptz);
drop function auth.accept_invitation(text, text, text);
drop function auth.invitation_lookup(text);
drop function auth.log_event(uuid, uuid, text, text, text, text, jsonb);
drop function auth.use_recovery_code(text, text);
drop function auth.mark_session_mfa_verified(text, bigint);
drop function auth.enable_totp(text, text[], bigint);
drop function auth.set_pending_totp_secret(text, text);
drop function auth.get_totp_secret(text);
drop function auth.session_user(text);
drop function auth.revoke_user_sessions(uuid);
drop function auth.revoke_session(text);
drop function auth.session_lookup(text, int);
drop function auth.create_session(uuid, text, int, text, text, boolean);
drop function auth.is_locked(uuid);
drop function auth.clear_login_failures(uuid);
drop function auth.record_login_failure(uuid, int, int);
drop function auth.login_lookup(text);
drop function auth.act_as(uuid, text);
drop table auth.auth_event;
drop table auth.mfa_recovery_code;
drop table auth.session;
drop table auth.login_state;
drop table user_installation_assignment;
drop table user_client_assignment;
drop table invitation;
drop table app_user;
drop function app.consultant_can_manage_role(user_role);
drop table tenant;
drop type user_status;
drop type user_role;
create or replace function app.register_business_table(p_table regclass, p_redact text[] default '{}')
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
revoke create on schema auth from cbam_auth;
revoke usage on schema public, app, audit, auth from cbam_auth;
revoke usage on schema auth from cbam_app;
drop schema auth;
