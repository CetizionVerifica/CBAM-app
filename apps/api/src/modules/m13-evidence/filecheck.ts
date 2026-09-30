import { EVIDENCE_FILE_TYPES, EVIDENCE_MAX_BYTES, type EvidenceContentType } from '@cbam/shared';
import { AppError } from '../../platform/errors';

/**
 * M13-R3: type and size limits, and content-type verification from the file's own bytes
 * (no malware scanner is configured). The extension must name an accepted type, and the
 * bytes must really be that type: a renamed .exe is refused whatever its name.
 */
export function checkEvidenceFile(fileName: string, body: Buffer): EvidenceContentType {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  const declared = (EVIDENCE_FILE_TYPES as Record<string, EvidenceContentType>)[ext];
  if (!declared) throw refused('Only PDF, PNG, JPEG, XLSX and CSV files are accepted.');
  if (body.length === 0) throw refused('This file is empty.');
  if (body.length > EVIDENCE_MAX_BYTES) throw new AppError(413, 'too_large', 'Files over 25 MB aren’t accepted. Split or compress the file.');
  if (sniff(body) !== declared) {
    throw refused(`This file is not a real ${ext.toUpperCase()} file. Export it again from the program that made it.`);
  }
  return declared;
}

const refused = (message: string) => new AppError(400, 'file_refused', message);

const startsWith = (body: Buffer, bytes: number[]) => bytes.every((b, i) => body[i] === b);

function sniff(body: Buffer): EvidenceContentType | null {
  if (body.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(body, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(body, [0x50, 0x4b, 0x03, 0x04])) {
    // Zip entry names are stored uncompressed, so an Excel workbook names its parts in clear.
    const text = body.toString('latin1');
    return text.includes('[Content_Types].xml') && text.includes('xl/workbook.xml')
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : null;
  }
  // CSV: UTF-8 text without control bytes other than tab, CR and LF.
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? null : 'text/csv';
  } catch {
    return null;
  }
}
