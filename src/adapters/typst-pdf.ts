// Typst-Wasm PDF compiler adapter — the concrete {@link TypstCompiler} boundary
// behind the Output_Engine's PDF renderer (R32.2).
//
// `@core/output`'s `renderPdf` builds an ATS-safe Typst document source and
// compiles it to PDF through the injected {@link TypstCompiler} contract; this
// adapter is the real implementation, backed by `@myriaddreamin/typst.ts`
// (Typst compiled to WebAssembly).
//
// Local-first (Requirement 1): the compiler WebAssembly module is BUNDLED with
// the app and resolved to a local asset URL via Vite's `?url` import, never
// fetched from a CDN — so no network request leaves the device to typeset a PDF.
// Remote font preloading (which would hit GitHub) is deliberately NOT enabled;
// the compiler uses its embedded default fonts.
//
// The heavy Typst JS is loaded LAZILY (dynamic import) on the first compile, so
// it lands in its own chunk and never weighs down initial load. Compilation is
// cached/initialised once per session.

import type { TypstCompiler } from '@core/output';
// Vite emits the ~20MB compiler wasm as a local asset and yields its URL here.
import compilerWasmUrl from '@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm?url';

/** Minimal shape of the `$typst` snippet helper we use. */
interface TypstSnippet {
  setCompilerInitOptions(options: { getModule: () => unknown }): void;
  pdf(options: { mainContent: string }): Promise<Uint8Array | undefined>;
}

let snippetReady: Promise<TypstSnippet> | null = null;

/** Lazily import and initialise the Typst snippet with the bundled wasm (once). */
const getTypst = (): Promise<TypstSnippet> => {
  if (!snippetReady) {
    snippetReady = import('@myriaddreamin/typst.ts/dist/esm/contrib/snippet.mjs').then(
      (mod) => {
        const $typst = (mod as unknown as { $typst: TypstSnippet }).$typst;
        // Point the compiler at the locally-bundled wasm asset (no CDN, R1).
        $typst.setCompilerInitOptions({ getModule: () => compilerWasmUrl });
        return $typst;
      },
    );
  }
  return snippetReady;
};

/**
 * Build the real Typst-Wasm {@link TypstCompiler}. `compile` returns the PDF
 * bytes or rejects on failure; `renderPdf` wraps it so a failure degrades
 * gracefully (the PDF is omitted, never blocking the Markdown/DOCX formats,
 * R32.2).
 */
export function createTypstPdfCompiler(): TypstCompiler {
  return {
    async compile(typstSource: string): Promise<Uint8Array> {
      const $typst = await getTypst();
      const pdf = await $typst.pdf({ mainContent: typstSource });
      if (!pdf) {
        throw new Error('Typst produced no PDF output.');
      }
      return pdf;
    },
  };
}
