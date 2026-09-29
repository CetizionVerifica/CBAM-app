/** A parsed CSV record and the file line it starts on (1-based), for row-numbered errors. */
export interface CsvRecord {
  line: number;
  cells: string[];
}

export class CsvSyntaxError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * RFC 4180 CSV: comma separator, double-quoted fields with "" escapes, CRLF or LF line
 * ends, optional UTF-8 BOM. Blank lines are skipped. Cells are returned untrimmed.
 */
export function parseCsv(text: string): CsvRecord[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;

  const endRecord = () => {
    cells.push(cell);
    if (!(cells.length === 1 && cells[0]!.trim() === '')) records.push({ line: recordLine, cells });
    cells = [];
    cell = '';
  };

  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        const next = src[i + 1];
        if (next !== undefined && next !== ',' && next !== '\r' && next !== '\n') {
          throw new CsvSyntaxError(line, 'Text follows a closing quote. Put the whole value in quotes.');
        }
        quoted = false;
        i += 1;
        continue;
      }
      if (ch === '\n') line += 1;
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (cell.trim() !== '') throw new CsvSyntaxError(line, 'A quote appears in the middle of a value. Put the whole value in quotes.');
      cell = '';
      quoted = true;
      i += 1;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
      i += 1;
    } else if (ch === '\r' || ch === '\n') {
      endRecord();
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
      line += 1;
      recordLine = line;
    } else {
      cell += ch;
      i += 1;
    }
  }
  if (quoted) throw new CsvSyntaxError(recordLine, 'A quoted value is not closed.');
  if (cell !== '' || cells.length > 0) endRecord();
  return records;
}
