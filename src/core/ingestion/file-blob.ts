// FileBlob — a minimal, framework-agnostic abstraction over an uploaded file.
//
// The Ingestion_Engine must run in the browser (over a real `File`) and under
// the Node test environment (over fixtures), so it never depends on the DOM
// `File` type directly. A `FileBlob` exposes only what ingestion needs: the
// file name (for format detection and the `DocId`), an optional MIME type, and
// async accessors for the raw bytes and decoded text. The browser `File` type
// already satisfies this shape, and the helpers below build deterministic
// blobs for tests and in-memory use.

/** The minimal uploaded-file surface the Ingestion_Engine consumes. */
export interface FileBlob {
  /** Original file name (drives format detection and the `DocId`). */
  readonly name: string;
  /** Optional MIME type, when the host provides one. */
  readonly mimeType?: string;
  /** The raw file bytes (for binary formats: PDF, ZIP). */
  bytes(): Promise<Uint8Array>;
  /** The decoded UTF-8 text (for text formats: Markdown, plain text). */
  text(): Promise<string>;
}

const UTF8 = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

/** Build a {@link FileBlob} from UTF-8 text (Markdown / plain-text fixtures). */
export const fileBlobFromText = (
  name: string,
  content: string,
  mimeType?: string,
): FileBlob => {
  const bytes = UTF8.encode(content);
  return {
    name,
    mimeType,
    bytes: async () => bytes,
    text: async () => content,
  };
};

/** Build a {@link FileBlob} from raw bytes (PDF / ZIP fixtures). */
export const fileBlobFromBytes = (
  name: string,
  data: Uint8Array,
  mimeType?: string,
): FileBlob => ({
  name,
  mimeType,
  bytes: async () => data,
  text: async () => UTF8_DECODER.decode(data),
});

/**
 * Adapt a DOM `File` (or any object exposing `name`, `type`, `arrayBuffer`, and
 * `text`) into a {@link FileBlob}. Kept structural so `@core` never references
 * the DOM `File` type.
 */
export const fileBlobFromFile = (file: {
  name: string;
  type?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}): FileBlob => ({
  name: file.name,
  mimeType: file.type,
  bytes: async () => new Uint8Array(await file.arrayBuffer()),
  text: () => file.text(),
});

/**
 * EAGERLY snapshot a DOM `File` (or any object exposing `name`, `type`, and
 * `arrayBuffer`) into an in-memory, byte-backed {@link FileBlob} by reading its
 * bytes RIGHT NOW.
 *
 * This exists to defeat a browser race: a `<input type="file">` that is reset
 * (`value = ''`) revokes the selected `File`, so a blob that reads the file
 * LAZILY later (during async ingestion) fails with a DOMException NotFoundError
 * ("A requested file or directory could not be found"). Reading the bytes up
 * front — while the `File` reference is still valid — decouples ingestion from
 * the live file handle, so a later reset/revocation cannot break the read.
 */
export const snapshotFileBlob = async (file: {
  name: string;
  type?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}): Promise<FileBlob> =>
  fileBlobFromBytes(file.name, new Uint8Array(await file.arrayBuffer()), file.type);
