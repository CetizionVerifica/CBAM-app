import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { testApp } from './helpers';

const t = testApp();
afterAll(() => t.close());

describe('app shell', () => {
  it('reports health once the database answers', async () => {
    const res = await request(t.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('answers unknown routes with a JSON 404 in plain words', async () => {
    const res = await request(t.app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({ code: 'not_found', message: 'This page or record does not exist.' });
  });
});
