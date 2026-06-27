// LinkedIn export ZIP / CSV boundary — the `JSZip` + `PapaParse` adapters (R8.2).
//
// Reading a `.zip` and parsing CSV are external concerns, so — as everywhere in
// the codebase — the heavy libraries live behind small ports here and `@core`
// depends only on the {@link ZipReader} and {@link CsvParser} interfaces. The
// domain logic that maps the parsed rows onto Profile / Positions / Skills /
// Certifications records lives in `@core/ingestion/linkedin` and is tested with
// fake ports, so no real archive or CSV is needed for unit tests.

import JSZip from 'jszip';
import Papa from 'papaparse';

/** A single text entry pulled from a ZIP archive. */
export interface ZipTextEntry {
  /** The entry's base file name (path components stripped). */
  readonly name: string;
  /** The entry's full path within the archive. */
  readonly path: string;
  /** The decoded UTF-8 text content. */
  readonly text: string;
}

/** Port: reads the text entries out of a ZIP archive (R8.2). */
export interface ZipReader {
  /** Read every non-directory text entry from the archive bytes. */
  readTextEntries(bytes: Uint8Array): Promise<ZipTextEntry[]>;
}

/** Port: parses CSV text into header-keyed row objects (R8.2). */
export interface CsvParser {
  /** Parse CSV text into a list of `{ header: value }` rows. */
  parse(csv: string): Record<string, string>[];
}

/** Base file name of a ZIP entry path (strips any directory components). */
const baseName = (path: string): string => path.split('/').pop() ?? path;

/** `JSZip`-backed {@link ZipReader}. */
export class JsZipReader implements ZipReader {
  async readTextEntries(bytes: Uint8Array): Promise<ZipTextEntry[]> {
    const archive = await JSZip.loadAsync(bytes);
    const entries: ZipTextEntry[] = [];
    const files = Object.values(archive.files).filter((f) => !f.dir);
    for (const file of files) {
      const text = await file.async('string');
      entries.push({ name: baseName(file.name), path: file.name, text });
    }
    return entries;
  }
}

/** `PapaParse`-backed {@link CsvParser} with header parsing and trimming. */
export class PapaParseCsvParser implements CsvParser {
  parse(csv: string): Record<string, string>[] {
    const result = Papa.parse<Record<string, string>>(csv, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim(),
    });
    return result.data.map((row) => {
      const clean: Record<string, string> = {};
      for (const [key, value] of Object.entries(row)) {
        clean[key] = typeof value === 'string' ? value.trim() : String(value ?? '');
      }
      return clean;
    });
  }
}

/** Convenience factories mirroring the other adapters' DI-friendly style. */
export const createZipReader = (): ZipReader => new JsZipReader();
export const createCsvParser = (): CsvParser => new PapaParseCsvParser();
