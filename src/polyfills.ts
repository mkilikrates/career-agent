// Browser polyfills for Node globals used by bundled dependencies.
//
// `gray-matter` (the Markdown frontmatter (de)serializer behind @core/markdown)
// calls `Buffer.from(...)` internally. `Buffer` is a Node global that Vite does
// NOT inject for the browser, so the first call into `serializeMarkdown` —
// e.g. persisting the confirmed Session Language to `config/locale.md` — would
// throw `ReferenceError: Buffer is not defined` and silently abort the action.
//
// This module makes the browser `Buffer` implementation available on the global
// object. It MUST be imported before any module that touches `gray-matter`
// (i.e. first in the app entrypoint). It is a no-op under Node/tests, where
// `Buffer` already exists.

import { Buffer } from 'buffer';

const globalScope = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
if (!globalScope.Buffer) {
  globalScope.Buffer = Buffer;
}
