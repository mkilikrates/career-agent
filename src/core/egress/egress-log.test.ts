// Unit tests for the egress log serializer/parser (R74.1, R74.3, R74.5).

import { describe, it, expect } from 'vitest';
import { asISODate } from '@core/types';
import {
  type EgressLogEntry,
  renderEgressLog,
  renderEgressLogEntry,
  parseEgressLog,
  EGRESS_LOG_HEADING,
} from './egress-log';

const entry: EgressLogEntry = {
  at: asISODate('2024-06-15T10:30:00.000Z'),
  operation: 'llm-chat',
  provider: 'openai',
  promptText: 'Hello, world!',
  responseText: 'Hi there!',
  redacted: false,
};

const redactedEntry: EgressLogEntry = {
  at: asISODate('2024-06-15T11:00:00.000Z'),
  operation: 'llm-chat',
  provider: 'anthropic',
  promptText: 'Tell me about [REDACTED]',
  responseText: 'Here is the answer.',
  redacted: true,
};

describe('egress-log serialization', () => {
  it('renderEgressLogEntry produces the expected format', () => {
    const rendered = renderEgressLogEntry(entry);
    expect(rendered).toContain('- [2024-06-15T10:30:00.000Z] **llm-chat** → openai');
    expect(rendered).toContain('- **Prompt:** Hello, world!');
    expect(rendered).toContain('- **Response:** Hi there!');
    expect(rendered).not.toContain('(redacted)');
  });

  it('renderEgressLogEntry marks redacted entries', () => {
    const rendered = renderEgressLogEntry(redactedEntry);
    expect(rendered).toContain('(redacted)');
  });

  it('renderEgressLog produces a full Markdown file', () => {
    const rendered = renderEgressLog([entry, redactedEntry]);
    expect(rendered).toContain(EGRESS_LOG_HEADING);
    expect(rendered.endsWith('\n')).toBe(true);
  });

  it('parseEgressLog round-trips entries', () => {
    const rendered = renderEgressLog([entry, redactedEntry]);
    const parsed = parseEgressLog(rendered);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual(entry);
    expect(parsed[1]).toEqual(redactedEntry);
  });

  it('parseEgressLog returns empty array on empty input', () => {
    expect(parseEgressLog('')).toEqual([]);
    expect(parseEgressLog(EGRESS_LOG_HEADING)).toEqual([]);
  });

  it('collapses multi-line prompt text to single line', () => {
    const multiLine: EgressLogEntry = {
      ...entry,
      promptText: 'Line one\nLine two\nLine three',
    };
    const rendered = renderEgressLog([multiLine]);
    const parsed = parseEgressLog(rendered);
    expect(parsed[0].promptText).toBe('Line one Line two Line three');
  });
});
