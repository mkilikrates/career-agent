// PII_Scanner — local high-risk PII and secrets pre-screening.
//
// Local regex + lightweight JS pattern matching that screens text for high-risk
// PII and secrets BEFORE any network transmission. Enforced by the Egress Gate
// (task 6.2), which fails closed when screening cannot complete. The scanner
// itself performs no I/O and makes no network calls — it is a pure, framework-
// agnostic function over a string, which keeps it trivially testable and safe
// to run on the hot egress path.
//
// Requirements:
//   R6.1 — scan locally via regex + lightweight JS matching before any send.
//   R6.2 — screen for SSN, NINO, credit card numbers, and API keys/tokens.
//   R6.4 — redact() removes detected high-risk values, producing the payload.
//   R6.5 — detected secrets are never preserved verbatim in the output.

import type { RedactedPayload } from './provider';

/** High-risk categories screened before transmission (R6.2). */
export type DetectionCategory = 'ssn' | 'nino' | 'credit_card' | 'api_key_or_token';

/**
 * A single detected high-risk span. The `[start, end)` half-open range and the
 * matched `value` let {@link PiiScanner.redact} remove *exactly* the detected
 * text (R6.4) without disturbing surrounding content.
 */
export interface Detection {
  readonly category: DetectionCategory;
  /** Inclusive start index of the match within the scanned text. */
  readonly start: number;
  /** Exclusive end index of the match within the scanned text. */
  readonly end: number;
  /** The exact substring that matched (i.e. `text.slice(start, end)`). */
  readonly value: string;
}

export interface PiiScanner {
  /** Local scan via regex + lightweight JS matching (R6.1, R6.2). */
  scan(text: string): Detection[];
  /** Remove detected high-risk values, producing the minimised payload (R6.4). */
  redact(text: string, detections: Detection[]): RedactedPayload;
}

/**
 * The placeholder substituted for each redacted span. It deliberately contains
 * no portion of the original secret, satisfying R6.5 (secrets are never echoed
 * verbatim). The category is included so downstream UI can explain what was
 * removed without revealing the value.
 */
function redactionMarker(category: DetectionCategory): string {
  return `[REDACTED:${category}]`;
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/**
 * A detector pairs a category with a global regular expression. Some categories
 * additionally apply a lightweight JS `validate` predicate over the matched
 * text to suppress false positives (e.g. the Luhn checksum for credit cards).
 */
interface Detector {
  readonly category: DetectionCategory;
  readonly pattern: RegExp;
  /** Optional secondary validation; if it returns false the match is dropped. */
  readonly validate?: (match: string) => boolean;
  /**
   * When set, the detected span/value is taken from this capture group rather
   * than the whole match. Used by the Bearer detector so the `Bearer` keyword
   * is preserved and only the token is redacted.
   */
  readonly captureGroup?: number;
}

/**
 * US Social Security Number: three-two-four digit groups separated by hyphens
 * or single spaces (e.g. `123-45-6789`). Requiring a separator avoids matching
 * arbitrary nine-digit runs. Area/group `000`, `666`, `9xx` and all-zero groups
 * are not valid SSNs and are screened out by {@link isPlausibleSsn}.
 */
const SSN_PATTERN = /\b(\d{3})([ -])(\d{2})\2(\d{4})\b/g;

function isPlausibleSsn(match: string): boolean {
  const groups = match.match(/\d+/g);
  if (!groups || groups.length !== 3) return false;
  const [area, group, serial] = groups;
  if (area === '000' || area === '666' || area.startsWith('9')) return false;
  if (group === '00') return false;
  if (serial === '0000') return false;
  return true;
}

/**
 * UK National Insurance Number: two prefix letters, six digits, one suffix
 * letter (A–D), optionally spaced (e.g. `AB 12 34 56 C`). The prefix letter
 * exclusions follow the official allocation rules: D, F, I, Q, U, V are never
 * used as either prefix letter; O is additionally disallowed as the second
 * letter; the administrative prefixes BG, GB, KN, NK, NT, TN and ZZ are
 * reserved. {@link isPlausibleNino} enforces the reserved-prefix exclusions.
 */
const NINO_PATTERN =
  /\b[ABCEGHJ-PRSTW-Z][ABCEGHJ-NPRSTW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/gi;

const RESERVED_NINO_PREFIXES = new Set(['BG', 'GB', 'KN', 'NK', 'NT', 'TN', 'ZZ']);

function isPlausibleNino(match: string): boolean {
  const prefix = match.slice(0, 2).toUpperCase();
  return !RESERVED_NINO_PREFIXES.has(prefix);
}

/**
 * Credit-card candidate: a run of 13–19 digits, optionally grouped by single
 * spaces or hyphens (e.g. `4111 1111 1111 1111`). Candidates are confirmed only
 * if they pass the Luhn checksum, which removes the vast majority of incidental
 * digit runs.
 */
const CREDIT_CARD_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;

/** Luhn (mod-10) checksum used to validate credit-card numbers (R6.2). */
function isLuhnValid(candidate: string): boolean {
  const digits = candidate.replace(/[^\d]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48; // '0' === 48
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * API key / token detectors covering common provider key shapes and bearer
 * tokens, plus a high-entropy fallback for long opaque hex/base64 strings.
 *
 * Each entry is a {@link Detector}; the more specific provider patterns run
 * before the generic high-entropy fallback so that, after overlap merging in
 * {@link DefaultPiiScanner.redact}, a recognised key is reported under its
 * specific shape rather than only as a generic token.
 */
const API_KEY_DETECTORS: Detector[] = [
  // OpenAI-style secret keys: `sk-...`, `sk-proj-...`, etc.
  { category: 'api_key_or_token', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g },
  // GitHub personal/OAuth/app/refresh/server tokens: ghp_, gho_, ghu_, ghs_, ghr_.
  { category: 'api_key_or_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  // GitHub fine-grained PAT.
  { category: 'api_key_or_token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  // AWS access key IDs (long-term AKIA, temporary ASIA).
  { category: 'api_key_or_token', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // Google API keys.
  { category: 'api_key_or_token', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Slack tokens.
  { category: 'api_key_or_token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  // Stripe live/test secret keys.
  { category: 'api_key_or_token', pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  // Bearer tokens in an Authorization header value: capture the token only.
  {
    category: 'api_key_or_token',
    pattern: /\bBearer\s+([A-Za-z0-9._~+/-]+=*)/gi,
    captureGroup: 1,
  },
];

/**
 * High-entropy fallback: a single opaque token of hex or base64/base64url
 * characters at least 32 chars long whose Shannon entropy exceeds a threshold.
 * This catches bespoke secrets that match no known provider prefix while
 * avoiding ordinary prose and identifiers (which have low per-character
 * entropy).
 */
const HIGH_ENTROPY_TOKEN_PATTERN = /\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g;
const MIN_TOKEN_ENTROPY_BITS = 3.5;

/** Shannon entropy (bits per character) of a string. */
function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function isHighEntropyToken(match: string): boolean {
  // Require a mix of character classes and sufficient entropy. Pure lowercase
  // words (even long ones) sit well below the threshold; random secrets do not.
  if (!/[0-9]/.test(match) && !/[A-Z]/.test(match)) return false;
  return shannonEntropy(match) >= MIN_TOKEN_ENTROPY_BITS;
}

/** All non-API-key detectors, evaluated in addition to {@link API_KEY_DETECTORS}. */
const CORE_DETECTORS: Detector[] = [
  { category: 'ssn', pattern: SSN_PATTERN, validate: isPlausibleSsn },
  { category: 'nino', pattern: NINO_PATTERN, validate: isPlausibleNino },
  { category: 'credit_card', pattern: CREDIT_CARD_PATTERN, validate: isLuhnValid },
];

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Default {@link PiiScanner}: regex + lightweight JS screening for SSNs, UK
 * NINOs, Luhn-valid credit-card numbers, and API keys/tokens. Construct once
 * and reuse; instances hold no mutable state between calls.
 */
export class DefaultPiiScanner implements PiiScanner {
  scan(text: string): Detection[] {
    if (text.length === 0) return [];
    const detections: Detection[] = [];

    for (const detector of CORE_DETECTORS) {
      this.collect(text, detector, detections);
    }
    for (const detector of API_KEY_DETECTORS) {
      this.collect(text, detector, detections);
    }
    // High-entropy fallback with its own validation.
    this.collect(
      text,
      {
        category: 'api_key_or_token',
        pattern: HIGH_ENTROPY_TOKEN_PATTERN,
        validate: isHighEntropyToken,
      },
      detections,
    );

    // Deterministic ordering: by start, then by widest span first.
    detections.sort((a, b) => a.start - b.start || b.end - a.end);
    return detections;
  }

  redact(text: string, detections: Detection[]): RedactedPayload {
    const spans = this.mergeSpans(text, detections);
    if (spans.length === 0) {
      return brandRedacted(text);
    }
    let out = '';
    let cursor = 0;
    for (const span of spans) {
      out += text.slice(cursor, span.start);
      out += redactionMarker(span.category);
      cursor = span.end;
    }
    out += text.slice(cursor);
    return brandRedacted(out);
  }

  /**
   * Run a single detector over the text, applying any secondary validation, and
   * push confirmed {@link Detection}s. Capturing detectors (e.g. Bearer) report
   * the captured group's span when present so the keyword itself is preserved.
   */
  private collect(text: string, detector: Detector, out: Detection[]): void {
    // Clone with a fresh lastIndex so the module-level regexes stay reentrant.
    const re = new RegExp(detector.pattern.source, detector.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1; // guard against zero-width matches
        continue;
      }
      // Take the configured capture group when present (e.g. Bearer token),
      // otherwise the whole match.
      const group = detector.captureGroup;
      const captured = group !== undefined ? m[group] : undefined;
      const useCapture = typeof captured === 'string' && captured.length > 0;
      const value = useCapture ? (captured as string) : m[0];
      const start = useCapture ? m.index + m[0].indexOf(value) : m.index;
      const end = start + value.length;
      if (detector.validate && !detector.validate(value)) {
        continue;
      }
      out.push({ category: detector.category, start, end, value });
    }
  }

  /**
   * Normalise detections into a sorted, non-overlapping list of spans clipped to
   * the bounds of `text`. Overlapping detections are merged into a single span;
   * the merged span adopts the category of the earliest, widest contributor,
   * which keeps redaction unambiguous when, say, a Bearer token wraps a `sk-`
   * key.
   */
  private mergeSpans(
    text: string,
    detections: Detection[],
  ): Array<{ start: number; end: number; category: DetectionCategory }> {
    const valid = detections
      .filter((d) => d.start >= 0 && d.end <= text.length && d.start < d.end)
      .map((d) => ({ start: d.start, end: d.end, category: d.category }))
      .sort((a, b) => a.start - b.start || b.end - a.end);

    const merged: Array<{ start: number; end: number; category: DetectionCategory }> = [];
    for (const span of valid) {
      const last = merged[merged.length - 1];
      if (last && span.start < last.end) {
        // Overlap: extend the existing span; keep the existing category.
        if (span.end > last.end) last.end = span.end;
      } else {
        merged.push({ ...span });
      }
    }
    return merged;
  }
}

/** Brand a redacted string as a {@link RedactedPayload}. */
function brandRedacted(text: string): RedactedPayload {
  return { __brand: 'RedactedPayload', text };
}

/** Convenience factory mirroring the other adapters' DI-friendly style. */
export function createPiiScanner(): PiiScanner {
  return new DefaultPiiScanner();
}
