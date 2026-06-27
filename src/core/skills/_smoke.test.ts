import { describe, it, expect } from 'vitest';
import { asSkillTerm } from '@core/types';
import {
  loadConfusablesFromYaml,
  loadConfusables,
  parseConfusables,
  normalise,
  DEFAULT_CONFUSABLES_YAML,
  toMergeRecord,
  splitMergeRecord,
} from './index';
import { asISODate } from '@core/types';

const t = (s: string) => asSkillTerm(s);

describe('smoke', () => {
  const conf = loadConfusablesFromYaml(DEFAULT_CONFUSABLES_YAML);

  it('parses default yaml into pairs', () => {
    const cfg = parseConfusables(DEFAULT_CONFUSABLES_YAML);
    expect(cfg.pairs?.length).toBe(7);
    expect(conf.isConfusable(t('java'), t('JavaScript'))).toBe(true);
    expect(conf.isConfusable(t('Java'), t('Python'))).toBe(false);
  });

  it('never merges confusable pairs', () => {
    const plan = normalise([t('Java'), t('JavaScript')], conf);
    expect(plan.merges).toEqual([]);
    expect(plan.skills.sort()).toEqual(['Java', 'JavaScript']);
  });

  it('merges casing/spelling variants', () => {
    const plan = normalise([t('JavaScript'), t('javascript'), t('JAVASCRIPT')], conf);
    expect(plan.skills).toEqual(['JavaScript']);
    expect(plan.merges).toHaveLength(1);
    expect(plan.merges[0].reason).toBe('casing-or-spelling-variant');
  });

  it('merges synonyms but never confusables among them', () => {
    const c = loadConfusables({
      pairs: [['Java', 'JavaScript']],
      synonyms: [['JavaScript', 'ECMAScript', 'JS']],
    });
    const plan = normalise([t('JavaScript'), t('ECMAScript'), t('JS'), t('Java')], c);
    expect(plan.skills.includes(asSkillTerm('Java'))).toBe(true);
    const merged = plan.merges.find((m) => m.reason === 'synonym');
    expect(merged?.from.sort()).toEqual(['ECMAScript', 'JS', 'JavaScript']);
    // Java stays separate (it is confusable with JavaScript)
    expect(plan.skills).toContain(asSkillTerm('Java'));
  });

  it('keeps umbrella terms as separate additional skills', () => {
    const c = loadConfusables({ umbrellas: ['Cloud'] });
    const plan = normalise([t('AWS'), t('Cloud'), t('Azure')], c);
    expect(plan.umbrellas).toEqual([asSkillTerm('Cloud')]);
    expect(plan.skills.sort()).toEqual(['AWS', 'Azure', 'Cloud']);
  });

  it('raises optional suggestion for uncertain similar pairs, not confusables', () => {
    const plan = normalise([t('Postgres'), t('Postgrey')], conf);
    expect(plan.merges).toEqual([]);
    expect(plan.suggestions).toHaveLength(1);
    // confusable similar pair gets no suggestion
    const plan2 = normalise([t('C'), t('C++')], conf);
    expect(plan2.suggestions).toEqual([]);
  });

  it('merge record is reversible in one step', () => {
    const plan = normalise([t('JavaScript'), t('javascript')], conf);
    const rec = toMergeRecord(plan.merges[0], asISODate('2024-01-01'));
    expect(rec.reversible).toBe(true);
    expect(splitMergeRecord(rec).sort()).toEqual(['JavaScript', 'javascript']);
  });

  it('never invents terms absent from source', () => {
    const input = [t('React'), t('React Native')];
    const plan = normalise(input, conf);
    for (const s of plan.skills) expect(input).toContain(s);
    expect(plan.merges).toEqual([]); // confusable pair
  });
});
