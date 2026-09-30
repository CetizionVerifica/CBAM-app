import { inflateRawSync } from 'node:zlib';
import { EVIDENCE_FILE_TYPES, EVIDENCE_MAX_BYTES, type EvidenceContentType } from '@cbam/shared';
import { AppError } from '../../platform/errors';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * M13-R3: type and size limits, and content-type verification from the file's own bytes
 * (no malware scanner is configured; D15). The name must end in an accepted extension, and
 * the bytes must really be that type: a renamed .exe is refused whatever its name, and an
 * XLSX must be a real, macro-free workbook (review M13 F5).
 */
export function checkEvidenceFile(fileName: string, body: Buffer): EvidenceContentType {
  const dot = fileName.lastIndexOf('.');
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  const declared = (EVIDENCE_FILE_TYPES as Record<string, EvidenceContentType>)[ext];
  if (!declared) throw refused('Only PDF, PNG, JPEG, XLSX and CSV files are accepted.');
  if (body.length === 0) throw refused('This file is empty.');
  if (body.length > EVIDENCE_MAX_BYTES) throw new AppError(413, 'too_large', 'Files over 25 MB aren’t accepted. Split or compress the file.');
  if (declared === XLSX) {
    checkWorkbook(body);
    return XLSX;
  }
  if (sniff(body) !== declared) throw notReal(ext);
  return declared;
}

const refused = (message: string) => new AppError(400, 'file_refused', message);
const notReal = (ext: string) => refused(`This file is not a real ${ext.toUpperCase()} file. Export it again from the program that made it.`);

const startsWith = (body: Buffer, bytes: number[]) => bytes.every((b, i) => body[i] === b);

function sniff(body: Buffer): EvidenceContentType | null {
  if (body.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(body, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(body, [0x50, 0x4b, 0x03, 0x04])) return null; // only as XLSX, checked separately
  // CSV: UTF-8 text without control bytes other than tab, CR and LF.
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? null : 'text/csv';
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// XLSX: read the ZIP central directory (no extraction to disk), require the workbook parts,
// and read [Content_Types].xml to confirm a plain spreadsheet with no macros.
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function zipEntries(zip: Buffer): ZipEntry[] {
  // End of central directory: signature 0x06054b50, within the last 22 + 65 535 bytes.
  const min = Math.max(0, zip.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = zip.length - 22; i >= min; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw notReal('xlsx');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw notReal('xlsx');
    const nameLength = zip.readUInt16LE(p + 28);
    const extraLength = zip.readUInt16LE(p + 30);
    const commentLength = zip.readUInt16LE(p + 32);
    entries.push({
      name: zip.subarray(p + 46, p + 46 + nameLength).toString('utf8'),
      method: zip.readUInt16LE(p + 10),
      compressedSize: zip.readUInt32LE(p + 20),
      localOffset: zip.readUInt32LE(p + 42),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(zip: Buffer, e: ZipEntry): Buffer {
  const p = e.localOffset;
  if (p + 30 > zip.length || zip.readUInt32LE(p) !== 0x04034b50) throw notReal('xlsx');
  const start = p + 30 + zip.readUInt16LE(p + 26) + zip.readUInt16LE(p + 28);
  const data = zip.subarray(start, start + e.compressedSize);
  if (e.method === 0) return data;
  if (e.method === 8) return inflateRawSync(data, { maxOutputLength: 1024 * 1024 });
  throw notReal('xlsx');
}

function checkWorkbook(body: Buffer): void {
  if (!startsWith(body, [0x50, 0x4b, 0x03, 0x04])) throw notReal('xlsx');
  let entries: ZipEntry[];
  let types: string;
  try {
    entries = zipEntries(body);
    const ct = entries.find((e) => e.name === '[Content_Types].xml');
    if (!ct || !entries.some((e) => e.name === 'xl/workbook.xml')) throw notReal('xlsx');
    types = readEntry(body, ct).toString('utf8');
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw notReal('xlsx'); // truncated or corrupt archive
  }
  if (!types.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')) throw notReal('xlsx');
  if (/macroEnabled|vbaProject/i.test(types) || entries.some((e) => /vbaProject\.bin$/i.test(e.name))) {
    throw refused('Workbooks with macros aren’t accepted. Save it as a plain .xlsx workbook and upload it again.');
  }
}
