import { describe, it, expect } from 'vitest';
import type { Accomplishment, ExtractedItem, ExtractedItemType } from '@core/types';
import {
  asBulletId,
  asDocId,
  asISODate,
  asItemId,
  asSkillId,
} from '@core/types';
import { sourceLine, trailOf } from '@core/provenance';
import {
  generate,
  presentForReview,
  addUserSkill,
  removeSkill,
  applyMerge,
  splitMerge,
  recordSelfAssessment,
  MissingSkillContextError,
  USER_CONFIRMATION_REF,
} from './index';

const DOC = asDocId('cv.pdf');
const AS_OF = asISODate('2024-01-01');

let seq = 0;
const item = (
  type: ExtractedItemType,
  fields: Record<string, unknown>,
  confidence: ExtractedItem['confidence'] = 'High',
  userConfirmed = false,
): ExtractedItem => ({
  id: asItemId(`r-item-${seq++}`),
  type,
  fields,
  confidence,
  provenance: trailOf(sourceLine(DOC, 1, JSON.stringify(fields))),
  userConfirmed,
  private: false,
  sourceDoc: DOC,
});

const skill = (name: string) => item('skill', { name });

const byName = (map: ReturnType<typeof generate>, name: string) =>
  map.entries.find((e) => e.name === name);

describe('skill-map review (R19)', () => {
  describe('R19.1 presentForReview', () => {
    it('surfaces entries and reversible merges without mutating the map', () => {
      const map = generate([skill('JavaScript'), skill('javascript'), skill('Python')], {
        asOf: AS_OF,
      });
      const review = presentForReview(map);
      expect(review.count).toBe(map.entries.length);
      expect(review.entries).toBe(map.entries);
      // The casing merge is surfaced as splittable.
      expect(review.merges).toHaveLength(1);
      expect(review.merges[0].skill).toBe(asSkillId('SKILL-javascript'));
      expect(review.merges[0].record.reversible).toBe(true);
    });
  });

  describe('R19.2 addUserSkill requires role/project + when', () => {
    it('rejects an addition missing the role/project', () => {
      const map = generate([skill('Python')], { asOf: AS_OF });
      expect(() =>
        addUserSkill(map, { name: 'Kafka', roleOrProject: '', when: '2022' }),
      ).toThrow(MissingSkillContextError);
    });

    it('rejects an addition missing the approximate time', () => {
      const map = generate([skill('Python')], { asOf: AS_OF });
      expect(() =>
        addUserSkill(map, { name: 'Kafka', roleOrProject: 'Acme platform', when: '   ' }),
      ).toThrow(MissingSkillContextError);
    });

    it('rejects an addition missing the name', () => {
      const map = generate([skill('Python')], { asOf: AS_OF });
      expect(() =>
        addUserSkill(map, { name: '  ', roleOrProject: 'Acme', when: '2022' }),
      ).toThrow(MissingSkillContextError);
    });

    it('adds the skill with user-confirmation provenance and required context', () => {
      const map = generate([skill('Python')], { asOf: AS_OF });
      const entry = addUserSkill(map, {
        name: 'Kafka',
        roleOrProject: 'Acme streaming platform',
        when: '2022-05',
      });
      expect(entry.name).toBe('Kafka');
      expect(byName(map, 'Kafka')).toBe(entry);
      // Provenance is a user confirmation referencing role/project + time.
      expect(entry.evidence).toHaveLength(1);
      expect(entry.evidence[0].ref).toBe(USER_CONFIRMATION_REF);
      expect(entry.evidence[0].note).toContain('Acme streaming platform');
      expect(entry.evidence[0].note).toContain('2022-05');
      expect(entry.proficiencySignal).toMatch(/user-confirmed/i);
      // No self-assessment is invented (R14.3).
      expect(entry.selfAssessment).toBeUndefined();
    });
  });

  describe('R19.3 remove', () => {
    it('removes a skill in one step and keeps the graph consistent', () => {
      const acc: Accomplishment = {
        id: asBulletId('BULLET-01'),
        text: 'Built a JS pipeline',
        provenance: trailOf(sourceLine(DOC, 2, 'pipeline')),
        skills: [asSkillId('SKILL-javascript')],
      };
      const map = generate([skill('JavaScript'), skill('Python')], {
        asOf: AS_OF,
        accomplishments: [acc],
      });
      expect(byName(map, 'JavaScript')).toBeDefined();
      expect(removeSkill(map, asSkillId('SKILL-javascript'))).toBe(true);
      expect(byName(map, 'JavaScript')).toBeUndefined();
      // The proof no longer resolves to a removed skill.
      expect(map.graph.skillsFor(asBulletId('BULLET-01'))).toEqual([]);
      // Removing a non-existent skill is a no-op.
      expect(removeSkill(map, asSkillId('SKILL-missing'))).toBe(false);
    });
  });

  describe('R19.3 one-step split restores originals', () => {
    it('splits an automatically merged skill back into the original surface terms', () => {
      const map = generate([skill('JavaScript'), skill('javascript'), skill('JAVASCRIPT')], {
        asOf: AS_OF,
      });
      const merged = byName(map, 'JavaScript')!;
      expect(merged.mergeRecord?.reversible).toBe(true);

      const restored = splitMerge(map, merged.id);
      const names = restored.map((e) => e.name).sort();
      expect(names).toEqual(['JAVASCRIPT', 'JavaScript', 'javascript']);

      // The three original surface terms are now separate entries...
      expect(byName(map, 'JavaScript')).toBeDefined();
      expect(byName(map, 'javascript')).toBeDefined();
      expect(byName(map, 'JAVASCRIPT')).toBeDefined();
      // ...each carrying its own evidence, and none still flagged as merged.
      for (const e of restored) {
        expect(e.evidence.length).toBeGreaterThanOrEqual(1);
        expect(e.mergeRecord).toBeUndefined();
      }
      // The representative keeps its stable id (proof links survive, R18.4).
      expect(byName(map, 'JavaScript')!.id).toBe(asSkillId('SKILL-javascript'));
    });

    it('reverses a user-initiated merge loss-free from the snapshot', () => {
      const map = generate([skill('Node.js'), skill('Node')], { asOf: AS_OF });
      const nodeJs = byName(map, 'Node.js')!;
      const node = byName(map, 'Node')!;
      const before = [nodeJs, node]
        .map((e) => ({ name: e.name, evidence: e.evidence.length }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const record = applyMerge(map, {
        skills: [nodeJs.id, node.id],
        into: nodeJs.id,
        reason: 'synonym',
        at: AS_OF,
      });
      expect(record.reversible).toBe(true);
      expect(record.into).toBe('Node.js' as never);
      expect(record.from).toContain('Node' as never);
      // Only the representative remains after the merge.
      expect(byName(map, 'Node')).toBeUndefined();
      expect(byName(map, 'Node.js')!.mergeRecord).toBe(record);

      const restored = splitMerge(map, nodeJs.id);
      const after = restored
        .map((e) => ({ name: e.name, evidence: e.evidence.length }))
        .sort((a, b) => a.name.localeCompare(b.name));
      // Loss-free: same terms and same evidence counts as before the merge.
      expect(after).toEqual(before);
    });

    it('returns an empty array when the skill was never merged', () => {
      const map = generate([skill('Python')], { asOf: AS_OF });
      expect(splitMerge(map, asSkillId('SKILL-python'))).toEqual([]);
    });
  });

  describe('R19.4 self-assessment is stored separately from the signal', () => {
    it('records the self-assessment without altering the evidence-based signal', () => {
      const map = generate([skill('Python')], { asOf: AS_OF });
      const before = byName(map, 'Python')!.proficiencySignal;

      const entry = recordSelfAssessment(map, asSkillId('SKILL-python'), {
        level: 'Expert',
        note: '8 years',
      })!;

      expect(entry.selfAssessment).toBe('Self-assessed: Expert — 8 years');
      // The evidence-based proficiency signal is untouched (R14.3).
      expect(entry.proficiencySignal).toBe(before);
      expect(entry.proficiencySignal).not.toMatch(/self-assessed/i);
    });

    it('returns undefined for an unknown skill', () => {
      const map = generate([skill('Python')], { asOf: AS_OF });
      expect(
        recordSelfAssessment(map, asSkillId('SKILL-missing'), { level: 'Beginner' }),
      ).toBeUndefined();
    });
  });
});
