import { it, expect } from 'vitest';
import { resolveReference, logicalURI } from '../../apps/viewer/src/renderer';
const origin = 'https://viewer.example', current = { hash: 'a'.repeat(40), path: 'pages/home.html', query: '', fragment: '' };
it('resolves relative references only within the current package and retains query/fragment', () => {
  expect(resolveReference('../style.css?v=2#x', current, origin)).toMatchObject({ path: 'style.css', query: '?v=2', fragment: '#x' });
  expect(resolveReference('/image.png', current, origin)?.path).toBe('image.png');
  expect(resolveReference('https://other.example/evil.js', current, origin)).toBeNull();
  expect(resolveReference(`../${'b'.repeat(40)}/index.html`, { ...current, path: 'index.html' }, origin)).toBeNull();
  expect(logicalURI({ ...current, query: '?a=1', fragment: '#b' })).toBe(`web+hppt://${current.hash}/pages/home.html?a=1#b`);
});
it.each(['%2e%2e/a', '%252e%252e/a', 'a%2fb', 'a%5cb', 'a\\b', '%00', '%ZZ'])('rejects encoded traversal or separators: %s', href => {
  expect(() => resolveReference(href, current, origin)).toThrow();
});
