import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

const root = resolve(import.meta.dirname, '../../..');

declare module 'vitest' {
  export interface ProvidedContext {
    ownerUrl: string;
    appUrl: string;
    /** Superuser; tests use it only to inspect data that RLS hides from every app role. */
    superUrl: string;
  }
}

let container: StartedPostgreSqlContainer;

/**
 * One Postgres per test run, created exactly like dev: db/init/01-roles.sh, then every
 * migration via dbmate as cbam_owner. Tests connect as cbam_app so RLS is exercised.
 */
export async function setup(project: TestProject) {
  const ownerPw = 'owner-test-pw';
  const appPw = 'app-test-pw';
  container = await new PostgreSqlContainer('postgres:17')
    .withEnvironment({ CBAM_OWNER_PASSWORD: ownerPw, CBAM_APP_PASSWORD: appPw })
    .withCopyFilesToContainer([
      { source: resolve(root, 'db/init/01-roles.sh'), target: '/docker-entrypoint-initdb.d/01-roles.sh' },
    ])
    .start();

  const host = container.getHost();
  const port = container.getPort();
  const ownerUrl = `postgres://cbam_owner:${ownerPw}@${host}:${port}/cbam?sslmode=disable`;
  const appUrl = `postgres://cbam_app:${appPw}@${host}:${port}/cbam?sslmode=disable`;

  execFileSync(
    resolve(root, 'node_modules/.bin/dbmate'),
    ['--migrations-dir', resolve(root, 'db/migrations'), '--no-dump-schema', '--wait', 'up'],
    { env: { ...process.env, DATABASE_URL: ownerUrl }, stdio: 'pipe' },
  );

  project.provide('ownerUrl', ownerUrl);
  project.provide('appUrl', appUrl);
  project.provide(
    'superUrl',
    `postgres://${container.getUsername()}:${container.getPassword()}@${host}:${port}/cbam?sslmode=disable`,
  );
}

export async function teardown() {
  await container?.stop();
}
