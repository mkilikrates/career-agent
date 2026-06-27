// Unit tests for the source-trace inspector projection (@ui) — task 19.2.
//
// These exercise the wiring between the inspector and the Provenance / Citation
// Service trace lookup (R38.2): a blank reference is the empty state, a known
// reference resolves to its full source trace with each provenance kind
// projected into an i18n-keyed citation, and an unknown reference resolves as
// unresolved. The provenance index is the real one; no provider/network is
// touched on this path.

import { describe, expect, it } from 'vitest';

import {
  ProvenanceIndex,
  interviewAnswer,
  sourceLine,
  userConfirmation,
} from '@core/provenance';
import { asBulletId, asDocId, asISODate, asSkillId, asStarId } from '@core/types';

import { inspectClaim, type TraceLookup } from './source-trace-inspector';

/** A trace lookup bound to a freshly built provenance index. */
function makeLookup(): { lookup: TraceLookup; index: ProvenanceIndex } {
  const index = new ProvenanceIndex();
  const lookup: TraceLookup = (ref) => index.lookup(ref);
  return { lookup, index };
}

describe('inspectClaim — empty state', () => {
  it('returns the empty state for a blank or whitespace-only reference', () => {
    const { lookup } = makeLookup();
    expect(inspectClaim(lookup, '')).toEqual({ status: 'empty' });
    expect(inspectClaim(lookup, '   ')).toEqual({ status: 'empty' });
  });
});

describe('inspectClaim — unresolved claims (R38.2)', () => {
  it('returns unresolved for a reference with no attached provenance', () => {
    const { lookup } = makeLookup();
    expect(inspectClaim(lookup, 'BULLET-99')).toEqual({
      status: 'unresolved',
      ref: 'BULLET-99',
    });
  });

  it('trims the reference before resolving', () => {
    const { lookup } = makeLookup();
    expect(inspectClaim(lookup, '  STAR-01  ')).toEqual({
      status: 'unresolved',
      ref: 'STAR-01',
    });
  });
});

describe('inspectClaim — resolved source trace (R38.2)', () => {
  it('projects a source_line record into its i18n-keyed citation', () => {
    const { lookup, index } = makeLookup();
    const ref = asBulletId('BULLET-01');
    index.attach(ref, sourceLine(asDocId('cv.pdf'), 12, 'Led the platform migration'));

    const view = inspectClaim(lookup, 'BULLET-01');

    expect(view).toEqual({
      status: 'resolved',
      ref: 'BULLET-01',
      citations: [
        {
          kind: 'source_line',
          i18nKey: 'inspector.citation.sourceLine',
          params: { doc: 'cv.pdf', line: 12, quote: 'Led the platform migration' },
        },
      ],
    });
  });

  it('projects a user_confirmation record into its i18n-keyed citation', () => {
    const { lookup, index } = makeLookup();
    const ref = asSkillId('SKILL-ci');
    index.attach(ref, userConfirmation(asISODate('2024-05-01'), 'confirmed in review'));

    const view = inspectClaim(lookup, 'SKILL-ci');

    expect(view).toEqual({
      status: 'resolved',
      ref: 'SKILL-ci',
      citations: [
        {
          kind: 'user_confirmation',
          i18nKey: 'inspector.citation.userConfirmation',
          params: { at: '2024-05-01', note: 'confirmed in review' },
        },
      ],
    });
  });

  it('projects an interview_answer record into its i18n-keyed citation', () => {
    const { lookup, index } = makeLookup();
    const ref = asBulletId('BULLET-02');
    index.attach(ref, interviewAnswer(asStarId('STAR-07')));

    const view = inspectClaim(lookup, 'BULLET-02');

    expect(view).toEqual({
      status: 'resolved',
      ref: 'BULLET-02',
      citations: [
        {
          kind: 'interview_answer',
          i18nKey: 'inspector.citation.interviewAnswer',
          params: { star: 'STAR-07' },
        },
      ],
    });
  });

  it('projects every record of a multi-citation trail in order', () => {
    const { lookup, index } = makeLookup();
    const ref = asBulletId('BULLET-03');
    index.attach(ref, sourceLine(asDocId('cv.pdf'), 3, 'first'));
    index.attach(ref, interviewAnswer(asStarId('STAR-09')));

    const view = inspectClaim(lookup, 'BULLET-03');

    expect(view.status).toBe('resolved');
    if (view.status !== 'resolved') return;
    expect(view.citations.map((c) => c.kind)).toEqual(['source_line', 'interview_answer']);
  });
});
