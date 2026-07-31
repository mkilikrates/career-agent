// Feature: career-agent, Property 3: Redaction completeness and egress boundary
//
// For any text payload containing seeded high-risk values (SSN pattern
// `\d{3}-\d{2}-\d{4}`, credit card `\d{4}-\d{4}-\d{4}-\d{4}`), after running
// through the PII scanner + redact, the output contains NONE of the original
// seeded values.
//
// **Validates: Requirements 6.1, 6.4, 6.5, 7.1, 7.2, 7.4**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createPiiScanner } from '@adapters/pii';

const scanner = createPiiScanner();

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Generate a valid SSN: area (001–665, 667–899), group (01–99), serial
 * (0001–9999). Formatted as `\d{3}-\d{2}-\d{4}`.
 */
const arbSSN = fc
  .tuple(
    fc.integer({ min: 1, max: 899 }).filter((n) => n !== 666),
    fc.integer({ min: 1, max: 99 }),
    fc.integer({ min: 1, max: 9999 }),
  )
  .map(([area, group, serial]) => {
    const a = String(area).padStart(3, '0');
    const g = String(group).padStart(2, '0');
    const s = String(serial).padStart(4, '0');
    return `${a}-${g}-${s}`;
  });

/**
 * Generate a Luhn-valid credit card number formatted as
 * `\d{4}-\d{4}-\d{4}-\d{4}`. We use the Luhn algorithm to compute the check
 * digit so the scanner's validation passes.
 */
const arbCreditCard = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 15, maxLength: 15 })
  .map((digits) => {
    // Compute Luhn check digit for the 15 prefix digits
    let sum = 0;
    for (let i = 0; i < 15; i++) {
      // Process from rightmost of the full 16-digit number:
      // Position 0 (rightmost) is the check digit, so prefix digit at index i
      // is at position (15 - i) in the final number.
      const pos = 15 - i; // position from rightmost (0-based)
      let d = digits[i];
      if (pos % 2 === 1) {
        // odd position from right → double
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    const check = (10 - (sum % 10)) % 10;
    const all = [...digits, check];
    // Format as XXXX-XXXX-XXXX-XXXX
    const s = all.map(String).join('');
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
  });

/** Generate base prose text without digits to avoid accidental PII-like runs. */
const arbBaseText = fc.stringMatching(/^[A-Za-z ]{5,80}$/);

/**
 * Generate a text payload with seeded PII at random positions. Returns both
 * the assembled text and the injected secret values so we can verify redaction.
 */
const arbPayloadWithSecrets = fc
  .tuple(
    fc.array(arbBaseText, { minLength: 1, maxLength: 5 }),
    fc.array(arbSSN, { minLength: 1, maxLength: 3 }),
    fc.array(arbCreditCard, { minLength: 1, maxLength: 3 }),
  )
  .map(([textParts, ssns, cards]) => {
    // Interleave text parts with secrets
    const secrets: string[] = [...ssns, ...cards];
    let payload = textParts[0];
    for (let i = 0; i < secrets.length; i++) {
      payload += ` ${secrets[i]} `;
      if (i + 1 < textParts.length) {
        payload += textParts[i + 1];
      }
    }
    // Append any remaining text parts
    for (let i = secrets.length + 1; i < textParts.length; i++) {
      payload += ` ${textParts[i]}`;
    }
    return { payload, secrets };
  });

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

describe('@core/egress — Property 3: Redaction completeness (PII scan + redact removes all seeded values)', () => {
  it('no seeded SSN or credit card survives after scan + redact', () => {
    fc.assert(
      fc.property(arbPayloadWithSecrets, ({ payload, secrets }) => {
        const detections = scanner.scan(payload);
        const redacted = scanner.redact(payload, detections);

        // None of the original injected secrets should survive in the redacted output
        for (const secret of secrets) {
          expect(
            redacted.text.includes(secret),
            `Secret "${secret}" survived redaction in: ${redacted.text}`,
          ).toBe(false);
        }
      }),
    );
  });

  it('redacted output contains redaction markers for detected values', () => {
    fc.assert(
      fc.property(arbPayloadWithSecrets, ({ payload }) => {
        const detections = scanner.scan(payload);
        // Only assert markers exist when there were actual detections
        if (detections.length > 0) {
          const redacted = scanner.redact(payload, detections);
          expect(redacted.text).toContain('[REDACTED:');
        }
      }),
    );
  });

  it('clean text passes through unmodified', () => {
    fc.assert(
      fc.property(arbBaseText, (text) => {
        const detections = scanner.scan(text);
        if (detections.length === 0) {
          const redacted = scanner.redact(text, detections);
          expect(redacted.text).toBe(text);
        }
      }),
    );
  });
});
