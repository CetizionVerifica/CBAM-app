import { randomBytes } from 'node:crypto';
import { v2 as cloudinary } from 'cloudinary';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { cloudinaryFileStore, memoryFileStore, parseCloudinaryUrl, sha256Of, unconfiguredFileStore } from './storage';

const URL = 'cloudinary://123456789012345:s3cr3t-Value_x@cetizion-dev';

afterEach(() => vi.restoreAllMocks());

describe('Cloudinary file store (decision D13)', () => {
  it('parses CLOUDINARY_URL and refuses anything else', () => {
    expect(parseCloudinaryUrl(URL)).toEqual({ cloud_name: 'cetizion-dev', api_key: '123456789012345', api_secret: 's3cr3t-Value_x' });
    expect(() => parseCloudinaryUrl('https://x:y@z')).toThrow(/cloudinary:\/\//);
  });

  it('uploads as a private raw file under the root folder, keeping the extension, and returns the SHA-256', async () => {
    const body = Buffer.from('%PDF-1.7 meter reading');
    const spy = vi.spyOn(cloudinary.uploader, 'upload_stream').mockImplementation(((options: Record<string, unknown>, cb: (e: unknown, r: unknown) => void) => ({
      end: (b: Buffer) => cb(undefined, { public_id: options.public_id, bytes: b.length }),
    })) as never);
    const store = cloudinaryFileStore(URL, 'cbam-dev');
    const stored = await store.put({ folder: 't1/c1/evidence', fileName: 'Meter Reading.PDF', body });

    const options = spy.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(options).toMatchObject({
      resource_type: 'raw',
      type: 'authenticated',
      overwrite: false,
      cloud_name: 'cetizion-dev',
      api_key: '123456789012345',
    });
    expect(options.public_id).toMatch(/^cbam-dev\/t1\/c1\/evidence\/[0-9a-f-]{36}\.pdf$/);
    expect(stored).toEqual({ key: options.public_id, bytes: body.length, sha256: sha256Of(body) });
  });

  it('gives signed download links that expire after 5 minutes by default', () => {
    vi.useFakeTimers({ now: new Date('2026-09-29T12:00:00Z') });
    try {
      const link = new globalThis.URL(cloudinaryFileStore(URL, 'cbam-dev').signedDownloadUrl('cbam-dev/t1/c1/evidence/a.pdf'));
      expect(link.origin + link.pathname).toBe('https://api.cloudinary.com/v1_1/cetizion-dev/raw/download');
      expect(link.searchParams.get('type')).toBe('authenticated');
      expect(link.searchParams.get('attachment')).toBe('true');
      expect(Number(link.searchParams.get('expires_at'))).toBe(Date.parse('2026-09-29T12:05:00Z') / 1000);
      expect(link.searchParams.get('signature')).toMatch(/^[0-9a-f]{40}$/);
      expect(link.toString()).not.toContain('s3cr3t'); // the secret signs the link; it is never in it
    } finally {
      vi.useRealTimers();
    }
  });

  it('deletes the private raw file and invalidates cached copies', async () => {
    const spy = vi.spyOn(cloudinary.uploader, 'destroy').mockResolvedValue({ result: 'ok' } as never);
    await cloudinaryFileStore(URL, 'cbam-dev').delete('cbam-dev/t1/c1/evidence/a.pdf');
    expect(spy).toHaveBeenCalledWith('cbam-dev/t1/c1/evidence/a.pdf', expect.objectContaining({ resource_type: 'raw', type: 'authenticated', invalidate: true }));
  });

  it('answers 503 when storage is not configured', async () => {
    await expect(unconfiguredFileStore().put({ folder: 'x', fileName: 'a.pdf', body: Buffer.from('x') })).rejects.toMatchObject({ status: 503, code: 'storage_unavailable' });
  });

  it('memory store round-trips files for tests', async () => {
    const store = memoryFileStore();
    const body = randomBytes(64);
    const f = await store.put({ folder: 't1', fileName: 'a.xlsx', body });
    expect(store.files.get(f.key)).toEqual(body);
    expect(store.signedDownloadUrl(f.key)).toMatch(/^memory:\/\/t1\/.+\.xlsx\?expires=\d+$/);
    await store.delete(f.key);
    expect(() => store.signedDownloadUrl(f.key)).toThrow();
  });
});

describe('storage configuration', () => {
  const base = {
    APP_DATABASE_URL: 'postgres://a:b@localhost:5432/cbam',
    WEB_ORIGIN: 'http://localhost:5173',
    TOTP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    SMTP_URL: 'smtp://localhost:1025',
  };

  it('is optional in development and required in production', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).CLOUDINARY_URL).toBeUndefined();
    expect(loadConfig({ ...base, NODE_ENV: 'development', CLOUDINARY_URL: '' }).CLOUDINARY_URL).toBeUndefined();
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/CLOUDINARY_URL \(is required in production\)/);
    expect(loadConfig({ ...base, NODE_ENV: 'production', CLOUDINARY_URL: URL }).CLOUDINARY_FOLDER).toBe('cbam-dev');
  });

  it('refuses a malformed URL without echoing the secret', () => {
    let message = '';
    try {
      loadConfig({ ...base, CLOUDINARY_URL: 'cloudinary://key-only@cloud' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/CLOUDINARY_URL \(must look like/);
  });
});
