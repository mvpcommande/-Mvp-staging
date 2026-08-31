import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './htmlEscape.mjs';

test('escapeHtml escapes the 5 HTML-relevant characters', () => {
  assert.equal(
    escapeHtml(`<script>alert('x') & "y"</script>`),
    '&lt;script&gt;alert(&#039;x&#039;) &amp; &quot;y&quot;&lt;/script&gt;'
  );
});

test('escapeHtml handles null/undefined/numbers without throwing', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
});
