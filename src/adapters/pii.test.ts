import { describe, expect, it } from 'vitest';
import { DefaultPiiScanner, createPiiScanner } from './pii';
import type { Detection, DetectionCategory } from './pii';

const scanner = new DefaultPiiScanner();

/** Categories present in a detection list. */
const categoriesOf = (detections: Detection[]): Set<DetectionCategory> =>
  new Set(detections.map((d) => d.category));

/** True if any detection of `category` exactly covers `value` in the text. */
const detected = (
  text: string,
  category: DetectionCategory,
  value: string,
): boolean =>
  scanner
    .scan(text)
    .some(
      (d) =>
        d.category === category &&
        d.value === value &&
        text.slice(d.start, d.end) === value,
    );

describe('DefaultPiiScanner — detection spans (R6.1)', () => {
  it('reports start/end/value that slice back to the matched text', () => {
    const text = 'My SSN is 123-45-6789, thanks.';
    const detections = scanner.scan(text);
    expect(detections.length).toBeGreaterThan(0);
    for (const d of detections) {
      expect(text.slice(d.start, d.end)).toBe(d.value);
      expect(d.start).toBeLessThan(d.end);
    }
  });

  it('returns no detections for an empty string', () => {
    expect(scanner.scan('')).toEqual([]);
  });
});

describe('DefaultPiiScanner — SSN (R6.2)', () => {
  it('detects a hyphenated US SSN', () => {
    expect(detected('SSN 123-45-6789', 'ssn', '123-45-6789')).toBe(true);
  });

  it('detects a space-separated US SSN', () => {
    expect(detected('SSN 123 45 6789', 'ssn', '123 45 6789')).toBe(true);
  });

  it('rejects invalid SSN area/group/serial groups', () => {
    expect(categoriesOf(scanner.scan('000-12-3456')).has('ssn')).toBe(false);
    expect(categoriesOf(scanner.scan('666-12-3456')).has('ssn')).toBe(false);
    expect(categoriesOf(scanner.scan('900-12-3456')).has('ssn')).toBe(false);
    expect(categoriesOf(scanner.scan('123-00-6789')).has('ssn')).toBe(false);
    expect(categoriesOf(scanner.scan('123-45-0000')).has('ssn')).toBe(false);
  });
});

describe('DefaultPiiScanner — UK NINO (R6.2)', () => {
  it('detects a compact NINO', () => {
    expect(detected('NINO AB123456C', 'nino', 'AB123456C')).toBe(true);
  });

  it('detects a spaced NINO', () => {
    expect(detected('NINO AB 12 34 56 C', 'nino', 'AB 12 34 56 C')).toBe(true);
  });

  it('rejects reserved administrative prefixes', () => {
    expect(categoriesOf(scanner.scan('BG123456C')).has('nino')).toBe(false);
    expect(categoriesOf(scanner.scan('ZZ123456C')).has('nino')).toBe(false);
  });
});

describe('DefaultPiiScanner — credit cards with Luhn (R6.2)', () => {
  it('detects a Luhn-valid Visa test number', () => {
    expect(detected('card 4242 4242 4242 4242', 'credit_card', '4242 4242 4242 4242')).toBe(
      true,
    );
  });

  it('detects a Luhn-valid number without separators', () => {
    expect(detected('card 4111111111111111', 'credit_card', '4111111111111111')).toBe(true);
  });

  it('rejects a number that fails the Luhn checksum', () => {
    expect(categoriesOf(scanner.scan('card 4111 1111 1111 1112')).has('credit_card')).toBe(
      false,
    );
  });

  it('rejects an arbitrary 16-digit run that is not Luhn-valid', () => {
    expect(categoriesOf(scanner.scan('order 1234567890123456')).has('credit_card')).toBe(
      false,
    );
  });
});

describe('DefaultPiiScanner — API keys and tokens (R6.2)', () => {
  it('detects an OpenAI-style secret key', () => {
    const key = 'sk-abcDEF1234567890ghijKLmnopqrst';
    expect(detected(`key=${key}`, 'api_key_or_token', key)).toBe(true);
  });

  it('detects a GitHub personal access token', () => {
    const key = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    expect(detected(`token ${key}`, 'api_key_or_token', key)).toBe(true);
  });

  it('detects an AWS access key id', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    expect(detected(`aws ${key}`, 'api_key_or_token', key)).toBe(true);
  });

  it('detects a bearer token while preserving the keyword', () => {
    const text = 'Authorization: Bearer abc.def.ghijklmnop';
    expect(detected(text, 'api_key_or_token', 'abc.def.ghijklmnop')).toBe(true);
    // The literal word "Bearer" is not part of the redacted secret value.
    expect(scanner.scan(text).some((d) => d.value.includes('Bearer'))).toBe(false);
  });

  it('detects a long high-entropy opaque token with no known prefix', () => {
    const detections = scanner.scan('secret 9f8E7d6C5b4A3z2y1X0wVuTsRqPoNmLkJiHgFeDc');
    expect(categoriesOf(detections).has('api_key_or_token')).toBe(true);
  });
});

describe('DefaultPiiScanner — clean text (R6.1)', () => {
  it('yields no detections for ordinary prose', () => {
    const text =
      'I led a team of five engineers to ship a payments platform in 2021, ' +
      'improving checkout conversion by 12 percent.';
    expect(scanner.scan(text)).toEqual([]);
  });

  it('leaves clean text unchanged through redaction', () => {
    const text = 'A perfectly ordinary sentence about my career.';
    const payload = scanner.redact(text, scanner.scan(text));
    expect(payload.text).toBe(text);
    expect(payload.__brand).toBe('RedactedPayload');
  });
});

describe('DefaultPiiScanner — redaction completeness (R6.4, R6.5)', () => {
  const SECRETS: Record<string, string> = {
    ssn: '123-45-6789',
    nino: 'AB123456C',
    credit_card: '4242 4242 4242 4242',
    openai_key: 'sk-abcDEF1234567890ghijKLmnopqrst',
    github_token: 'ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
    aws_key: 'AKIAIOSFODNN7EXAMPLE',
  };

  it('removes every detected secret value from the output (no verbatim survival)', () => {
    const text =
      `SSN ${SECRETS.ssn}. NINO ${SECRETS.nino}. ` +
      `Card ${SECRETS.credit_card}. Key ${SECRETS.openai_key}. ` +
      `GH ${SECRETS.github_token}. AWS ${SECRETS.aws_key}.`;
    const detections = scanner.scan(text);
    const payload = scanner.redact(text, detections);

    for (const secret of Object.values(SECRETS)) {
      expect(payload.text.includes(secret)).toBe(false);
    }
    // Surrounding, non-secret context is preserved.
    expect(payload.text.includes('SSN')).toBe(true);
    expect(payload.text.includes('[REDACTED:')).toBe(true);
  });

  it('redacts exactly the detected spans and nothing else', () => {
    const text = 'before 123-45-6789 after';
    const payload = scanner.redact(text, scanner.scan(text));
    expect(payload.text).toBe('before [REDACTED:ssn] after');
  });

  it('merges overlapping detections into a single redaction', () => {
    const text = 'Authorization: Bearer sk-abcDEF1234567890ghijKLmnopqrst';
    const payload = scanner.redact(text, scanner.scan(text));
    expect(payload.text.includes('sk-')).toBe(false);
    expect(payload.text.startsWith('Authorization: Bearer [REDACTED:')).toBe(true);
  });

  it('ignores detections with out-of-range indices', () => {
    const text = 'clean text';
    const bogus: Detection[] = [
      { category: 'ssn', start: -5, end: 3, value: 'xxx' },
      { category: 'ssn', start: 5, end: 999, value: 'yyy' },
      { category: 'ssn', start: 4, end: 4, value: '' },
    ];
    expect(scanner.redact(text, bogus).text).toBe(text);
  });
});

describe('createPiiScanner factory', () => {
  it('produces a working scanner', () => {
    const s = createPiiScanner();
    expect(categoriesOf(s.scan('SSN 123-45-6789')).has('ssn')).toBe(true);
  });
});
