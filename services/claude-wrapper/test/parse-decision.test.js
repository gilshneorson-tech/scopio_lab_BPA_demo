import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { parseDecision } = await import('../src/index.js');

describe('parseDecision', () => {
  test('parses a clean JSON response', () => {
    const d = parseDecision('{"action": "ANSWER", "response": "Yes, FDA cleared.", "section": null}');
    assert.deepEqual(d, { action: 'ANSWER', responseText: 'Yes, FDA cleared.', section: null });
  });

  test('parses JSON wrapped in preamble and trailing prose', () => {
    const d = parseDecision(
      'Sure! Here is my decision:\n{"action": "ANSWER", "response": "Great question.", "section": "scan_viewer"}\nLet me know if you need anything else.',
    );
    assert.equal(d.action, 'ANSWER');
    assert.equal(d.section, 'scan_viewer');
  });

  test('REGRESSION: two JSON objects in output does not break parsing (greedy-regex bug)', () => {
    const d = parseDecision(
      '{"action": "ADVANCE", "response": "", "section": null} {"note": "ignored"}',
    );
    assert.equal(d.action, 'ADVANCE');
  });

  test('handles braces inside string values', () => {
    const d = parseDecision('{"action": "ANSWER", "response": "Use the {settings} menu.", "section": null}');
    assert.equal(d.responseText, 'Use the {settings} menu.');
  });

  test('rejects an unknown action (never invents WAIT or speaks raw output)', () => {
    assert.equal(parseDecision('{"action": "PONDER", "response": "hmm"}'), null);
  });

  test('rejects an invalid section but keeps the decision', () => {
    const d = parseDecision('{"action": "ANSWER", "response": "ok", "section": "the_scan_thing"}');
    assert.equal(d.action, 'ANSWER');
    assert.equal(d.section, null);
  });

  test('rejects free text with no JSON at all', () => {
    assert.equal(parseDecision('I think we should move on to the next section now.'), null);
  });

  test('rejects empty input', () => {
    assert.equal(parseDecision(''), null);
    assert.equal(parseDecision(null), null);
  });
});
