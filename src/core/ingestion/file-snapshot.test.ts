// Regression test for the ingestion file-read race (Ingest screen).
//
// A `<input type="file">` that is reset (`value = ''`) revokes the selected
// `File`, so a blob that reads the file LAZILY during async ingestion fails with
// a DOMException NotFoundError ("A requested file or directory could not be
// found"). `snapshotFileBlob` defeats this by reading the bytes EAGERLY, up
// front, while the `File` reference is still valid. These tests simulate a File
// whose `arrayBuffer()` succeeds now but throws once the input is "reset", and
// assert the snapshot already holds the bytes.

import { describe, it, expect } from 'vitest';
import { snapshotFileBlob, fileBlobFromFile } from './file-blob';

const UTF8 = new TextEncoder();

/**
 * A File-like that becomes unreadable after {@link revoke} is called — exactly
 * how a browser revokes a selected File when its input is reset. Reads before
 * revocation succeed; reads after throw the NotFoundError shape.
 */
class RevocableFile {
  private revoked = false;
  constructor(
    readonly name: string,
    private readonly bytes: Uint8Array,
    readonly type = 'application/pdf',
  ) {}

  revoke(): void {
    this.revoked = true;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    if (this.revoked) {
      const err = new Error(
        'A requested file or directory could not be found at the time an operation was processed.',
      );
      err.name = 'NotFoundError';
      throw err;
    }
    return this.bytes.slice().buffer as ArrayBuffer;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.arrayBuffer());
  }
}

describe('snapshotFileBlob — eager read defeats the input-reset race', () => {
  it('captures the bytes up front, so a later revoke cannot break the read', async () => {
    const file = new RevocableFile('LinkedinProfile.pdf', UTF8.encode('%PDF-1.7 hello'));

    // Snapshot while the File is still valid (as the Ingest screen now does).
    const blob = await snapshotFileBlob(file);

    // Now the input is reset → the source File is revoked.
    file.revoke();

    // The snapshot already holds the bytes, so ingestion still succeeds.
    const bytes = await blob.bytes();
    expect(new TextDecoder().decode(bytes)).toBe('%PDF-1.7 hello');
    expect(blob.name).toBe('LinkedinProfile.pdf');
    expect(blob.mimeType).toBe('application/pdf');
  });

  it('decodes text from the same eagerly-read bytes after revocation', async () => {
    const file = new RevocableFile('notes.md', UTF8.encode('# Notes'), 'text/markdown');
    const blob = await snapshotFileBlob(file);
    file.revoke();
    expect(await blob.text()).toBe('# Notes');
  });

  it('demonstrates the bug a LAZY blob would have hit (reads after revoke throw)', async () => {
    const file = new RevocableFile('cv.pdf', UTF8.encode('%PDF'));
    // The OLD lazy adapter defers the read until bytes() is called.
    const lazy = fileBlobFromFile(file);
    file.revoke(); // input reset before the deferred read

    await expect(lazy.bytes()).rejects.toThrow(/could not be found/i);
  });
});
