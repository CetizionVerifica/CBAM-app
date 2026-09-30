import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { v2 as cloudinary } from 'cloudinary';
import { AppError } from './errors';

/**
 * File storage for evidence (M13) and generated reports (M12), on Cloudinary (decision D13).
 * Files are uploaded through the API, which has already checked size and type; the store
 * computes SHA-256 and keeps files private. Downloads are signed links that expire (M13-R2).
 */
export interface StoredFile {
  /** Cloudinary public id; store it on the record that owns the file. */
  key: string;
  bytes: number;
  sha256: string;
}

export interface PutFile {
  /** Folder path under the configured root, e.g. `${tenantId}/${clientId}/evidence`. */
  folder: string;
  fileName: string;
  body: Buffer;
}

export interface FileStore {
  put(file: PutFile): Promise<StoredFile>;
  /** A link that downloads the file as an attachment and stops working after `expiresInSeconds`. */
  signedDownloadUrl(key: string, options?: { expiresInSeconds?: number }): string;
  delete(key: string): Promise<void>;
}

/** Download links are valid for 5 minutes (phase 1 plan, "Files"). */
export const DOWNLOAD_LINK_SECONDS = 300;

export const sha256Of = (body: Buffer) => createHash('sha256').update(body).digest('hex');

/** Parses cloudinary://<api_key>:<api_secret>@<cloud_name>. */
export function parseCloudinaryUrl(url: string) {
  const u = new URL(url);
  if (u.protocol !== 'cloudinary:' || !u.username || !u.password || !u.hostname) {
    throw new Error('CLOUDINARY_URL must look like cloudinary://<api_key>:<api_secret>@<cloud_name>');
  }
  return { cloud_name: u.hostname, api_key: decodeURIComponent(u.username), api_secret: decodeURIComponent(u.password) };
}

/**
 * Every file is a `raw` resource with delivery type `authenticated`: never public, never
 * transformed, and served only through signed, expiring download links. Credentials are
 * passed per call, so the SDK's global configuration is never used.
 */
export function cloudinaryFileStore(cloudinaryUrl: string, rootFolder: string): FileStore {
  const account = parseCloudinaryUrl(cloudinaryUrl);
  const base = { ...account, resource_type: 'raw' as const, type: 'authenticated' as const };

  return {
    async put({ folder, fileName, body }) {
      const sha256 = sha256Of(body);
      // Raw public ids keep the extension so the download has the right file type.
      const ext = extname(fileName).toLowerCase().replace(/[^.a-z0-9]/g, '');
      const publicId = `${rootFolder}/${folder}/${randomUUID()}${ext}`;
      const result = await new Promise<{ public_id: string; bytes: number }>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { ...base, public_id: publicId, overwrite: false, use_filename: false, unique_filename: false },
          (err, res) => (err || !res ? reject(err ?? new Error('Cloudinary returned no result')) : resolve(res)),
        );
        stream.end(body);
      });
      return { key: result.public_id, bytes: result.bytes, sha256 };
    },

    signedDownloadUrl(key, { expiresInSeconds = DOWNLOAD_LINK_SECONDS } = {}) {
      return cloudinary.utils.private_download_url(key, '', {
        ...base,
        attachment: true,
        expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
      });
    },

    async delete(key) {
      await cloudinary.uploader.destroy(key, { ...base, invalidate: true });
    },
  };
}

/** Used when CLOUDINARY_URL is not set: every call fails with a clear 503. */
export function unconfiguredFileStore(): FileStore {
  const fail = (): never => {
    throw new AppError(503, 'storage_unavailable', 'File storage is not set up on this server. Ask an administrator to configure it.');
  };
  return { put: async () => fail(), signedDownloadUrl: fail, delete: async () => fail() };
}

/** Keeps files in memory; used by tests. `open` follows a download link as Cloudinary does. */
export function memoryFileStore(): FileStore & { files: Map<string, Buffer>; open(url: string): Buffer } {
  const files = new Map<string, Buffer>();
  return {
    files,
    open(url) {
      const u = new URL(url);
      if (Date.now() / 1000 > Number(u.searchParams.get('expires'))) throw new AppError(401, 'expired', 'This download link has expired.');
      const file = files.get(`${u.hostname}${u.pathname}`);
      if (!file) throw new AppError(404, 'not_found', 'This file does not exist.');
      return file;
    },
    async put({ folder, fileName, body }) {
      const key = `${folder}/${randomUUID()}${extname(fileName).toLowerCase()}`;
      files.set(key, Buffer.from(body));
      return { key, bytes: body.length, sha256: sha256Of(body) };
    },
    signedDownloadUrl(key, { expiresInSeconds = DOWNLOAD_LINK_SECONDS } = {}) {
      if (!files.has(key)) throw new AppError(404, 'not_found', 'This file does not exist.');
      return `memory://${key}?expires=${Math.floor(Date.now() / 1000) + expiresInSeconds}`;
    },
    async delete(key) {
      files.delete(key);
    },
  };
}
