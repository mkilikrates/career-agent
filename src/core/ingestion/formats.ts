// Format detection, accept / reject, and the recommended document checklist
// (R8.1, R8.3, R8.4).
//
// The Ingestion_Engine accepts exactly four launch formats — PDF, Markdown,
// plain text, and a LinkedIn data-export ZIP — and rejects everything else with
// an explicit "deferred to a later phase" notice rather than partially parsing
// it (R8.1, R8.3; design §Error Handling). Detection consults both the file
// extension and any MIME type the host supplied, so a `.md` file with a
// `text/markdown` type and a `.zip` with `application/zip` both resolve
// correctly, and an unknown/empty type falls back to the extension.

import type { Locale } from '@adapters/provider';
import type { FileBlob } from './file-blob';

/** The four launch-supported ingestion formats (R8.1). */
export type Format = 'pdf' | 'markdown' | 'plain-text' | 'linkedin-zip' | 'docx';

/** The accepted launch formats, in a stable presentation order (R8.1). */
export const ACCEPTED_FORMATS: readonly Format[] = [
  'pdf',
  'markdown',
  'plain-text',
  'linkedin-zip',
  'docx',
] as const;

/** The launch-supported formats (R8.1). */
export const acceptedFormats = (): Format[] => [...ACCEPTED_FORMATS];

/**
 * A rejection notice for an out-of-scope format (R8.3). It names the detected
 * kind (e.g. `docx`, `image`) and carries the user-facing "deferred to a later
 * phase" message — it never attempts a partial parse (design §Error Handling).
 */
export interface RejectionNotice {
  readonly fileName: string;
  /** A friendly label for the detected, unsupported kind (e.g. `docx`). */
  readonly detectedKind: string;
  /** Always `deferred`: the format is planned for a later phase, not invalid. */
  readonly reason: 'deferred';
  /** User-facing message stating the format is deferred to a later phase. */
  readonly message: string;
}

/** The result of classifying an uploaded file (R8.1, R8.3). */
export type FormatDetection =
  | { readonly accepted: true; readonly fileName: string; readonly format: Format }
  | { readonly accepted: false; readonly fileName: string; readonly rejection: RejectionNotice };

/** Lower-cased file extension (without the dot), or `''` when there is none. */
export const extensionOf = (name: string): string => {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

/** Map of supported extensions → canonical {@link Format}. */
const EXTENSION_FORMATS: Readonly<Record<string, Format>> = {
  pdf: 'pdf',
  md: 'markdown',
  markdown: 'markdown',
  mdown: 'markdown',
  txt: 'plain-text',
  text: 'plain-text',
  zip: 'linkedin-zip',
  docx: 'docx',
};

/** Map of supported MIME types → canonical {@link Format}. */
const MIME_FORMATS: Readonly<Record<string, Format>> = {
  'application/pdf': 'pdf',
  'text/markdown': 'markdown',
  'text/x-markdown': 'markdown',
  'text/plain': 'plain-text',
  'application/zip': 'linkedin-zip',
  'application/x-zip-compressed': 'linkedin-zip',
  'multipart/x-zip': 'linkedin-zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

/**
 * Friendly labels for known but out-of-scope formats, so the rejection notice
 * can explain precisely what was deferred (DOCX, OCR/image, etc. — R8.3,
 * design §Error Handling). Anything not listed is reported as `unknown`.
 */
const DEFERRED_KINDS: Readonly<Record<string, string>> = {
  doc: 'legacy Word (.doc)',
  odt: 'OpenDocument (.odt)',
  rtf: 'rich text (.rtf)',
  pages: 'Apple Pages',
  html: 'HTML',
  htm: 'HTML',
  png: 'image (.png)',
  jpg: 'image (.jpg)',
  jpeg: 'image (.jpeg)',
  gif: 'image (.gif)',
  tif: 'scanned image (.tif)',
  tiff: 'scanned image (.tiff)',
  bmp: 'image (.bmp)',
  webp: 'image (.webp)',
  heic: 'image (.heic)',
  csv: 'loose CSV (upload the full LinkedIn export ZIP instead)',
};

/** Build the "deferred to a later phase" message for a detected kind (R8.3). */
const deferredMessage = (kind: string): string =>
  `This ${kind} file is not supported in the launch phase. Support for it is ` +
  `deferred to a later phase. Please upload a PDF, Markdown, plain-text, or ` +
  `LinkedIn export ZIP file instead.`;

/** Classify the MIME type, if any, to a supported {@link Format}. */
const formatFromMime = (mimeType?: string): Format | undefined => {
  if (!mimeType) return undefined;
  const normalized = mimeType.split(';')[0].trim().toLowerCase();
  return MIME_FORMATS[normalized];
};

/**
 * Classify an uploaded file into a supported {@link Format}, or produce a
 * rejection notice for an out-of-scope format (R8.1, R8.3). MIME type takes
 * precedence when it maps to a supported format; otherwise the extension is
 * consulted. A file with neither a recognised extension nor MIME type is
 * rejected as `unknown` rather than guessed at.
 */
export const detectFormat = (file: FileBlob): FormatDetection => {
  const mimeFormat = formatFromMime(file.mimeType);
  if (mimeFormat) {
    return { accepted: true, fileName: file.name, format: mimeFormat };
  }

  const ext = extensionOf(file.name);
  const extFormat = EXTENSION_FORMATS[ext];
  if (extFormat) {
    return { accepted: true, fileName: file.name, format: extFormat };
  }

  const detectedKind = DEFERRED_KINDS[ext] ?? (ext ? `.${ext}` : 'unknown');
  return {
    accepted: false,
    fileName: file.name,
    rejection: {
      fileName: file.name,
      detectedKind,
      reason: 'deferred',
      message: deferredMessage(detectedKind),
    },
  };
};

/** True when the file is one of the launch-supported formats (R8.1). */
export const isAccepted = (file: FileBlob): boolean => detectFormat(file).accepted;

/**
 * Build the rejection notice for an out-of-scope file (R8.3). Intended to be
 * called for files that {@link detectFormat} has already classified as
 * unsupported; if called on a supported file it still returns a notice (the
 * caller is expected to gate on {@link isAccepted} / {@link detectFormat}).
 */
export const rejectUnsupported = (file: FileBlob): RejectionNotice => {
  const detection = detectFormat(file);
  if (!detection.accepted) return detection.rejection;
  const ext = extensionOf(file.name);
  const detectedKind = DEFERRED_KINDS[ext] ?? (ext ? `.${ext}` : 'unknown');
  return {
    fileName: file.name,
    detectedKind,
    reason: 'deferred',
    message: deferredMessage(detectedKind),
  };
};

// --- Recommended document checklist (R8.4) -------------------------------

/** A single recommended-document checklist row presented before ingestion. */
export interface ChecklistItem {
  /** Stable, locale-independent key (e.g. `most_recent_cv`). */
  readonly id: string;
  /** Short, localised label. */
  readonly label: string;
  /** Localised one-line description of why the document helps. */
  readonly description: string;
  /** Whether this document is strongly recommended (vs. optional but useful). */
  readonly recommended: boolean;
}

/** Locale-independent checklist structure; labels are filled per language. */
interface ChecklistEntry {
  readonly id: string;
  readonly recommended: boolean;
  readonly en: { label: string; description: string };
  readonly ptBR: { label: string; description: string };
}

const CHECKLIST_ENTRIES: readonly ChecklistEntry[] = [
  {
    id: 'most_recent_cv',
    recommended: true,
    en: {
      label: 'Your most recent CV / résumé',
      description: 'A current PDF, Markdown, or text CV gives the richest, most up-to-date history.',
    },
    ptBR: {
      label: 'Seu currículo mais recente',
      description: 'Um currículo atual em PDF, Markdown ou texto fornece o histórico mais completo e atualizado.',
    },
  },
  {
    id: 'previous_cv_versions',
    recommended: true,
    en: {
      label: 'Older CV versions',
      description: 'Earlier versions help recover roles or details dropped from your latest CV.',
    },
    ptBR: {
      label: 'Versões anteriores do currículo',
      description: 'Versões antigas ajudam a recuperar cargos ou detalhes que saíram do currículo atual.',
    },
  },
  {
    id: 'linkedin_export',
    recommended: true,
    en: {
      label: 'Your LinkedIn data export (ZIP)',
      description: 'Request "Get a copy of your data" from LinkedIn; the ZIP includes positions, skills, and certifications.',
    },
    ptBR: {
      label: 'Exportação de dados do LinkedIn (ZIP)',
      description: 'Solicite "Obter uma cópia dos seus dados" no LinkedIn; o ZIP inclui cargos, competências e certificações.',
    },
  },
  {
    id: 'certifications',
    recommended: false,
    en: {
      label: 'Certificates and licenses',
      description: 'Certification documents confirm issuing body and dates with high confidence.',
    },
    ptBR: {
      label: 'Certificados e licenças',
      description: 'Documentos de certificação confirmam emissor e datas com alta confiança.',
    },
  },
  {
    id: 'education_records',
    recommended: false,
    en: {
      label: 'Education records or transcripts',
      description: 'Diplomas or transcripts confirm institutions, qualifications, and dates.',
    },
    ptBR: {
      label: 'Documentos de formação ou históricos',
      description: 'Diplomas ou históricos confirmam instituições, qualificações e datas.',
    },
  },
  {
    id: 'cover_letters',
    recommended: false,
    en: {
      label: 'Cover letters or project write-ups',
      description: 'These often contain quantified results and context not present on a CV.',
    },
    ptBR: {
      label: 'Cartas de apresentação ou descrições de projetos',
      description: 'Costumam conter resultados quantificados e contexto ausentes no currículo.',
    },
  },
];

/** True when the locale tag selects Brazilian Portuguese. */
const isPtBr = (locale: Locale): boolean => locale.toLowerCase().startsWith('pt');

/**
 * The recommended document checklist presented to the user before ingestion
 * begins (R8.4), localised to the session language (English or Brazilian
 * Portuguese; other Tier-1 region tags fall back to English).
 */
export const recommendedChecklist = (locale: Locale): ChecklistItem[] => {
  const pt = isPtBr(locale);
  return CHECKLIST_ENTRIES.map((entry) => {
    const strings = pt ? entry.ptBR : entry.en;
    return {
      id: entry.id,
      label: strings.label,
      description: strings.description,
      recommended: entry.recommended,
    };
  });
};
