import { expect, it } from 'vitest';
import { normalizeAppOrigin, normalizeViewerOrigin } from '../../scripts/origins';

it('shares a local frontend port while keeping controller and viewer hostnames separate', () => {
  const app = normalizeAppOrigin();
  expect(app).toBe('http://app.hppt.localhost:5173');
  expect(normalizeViewerOrigin(undefined, app)).toBe('http://hppt.localhost:5173');
  expect(normalizeViewerOrigin(undefined, 'http://app.hppt.localhost:5273')).toBe('http://hppt.localhost:5273');
});
it('migrates legacy local viewer configurations without changing the app storage origin', () => {
  const app = normalizeAppOrigin('http://app.hppt.localhost:5173');
  for (const value of ['http://localhost:5174', 'http://127.0.0.1:5174', 'http://hppt.localhost:5174']) {
    expect(normalizeViewerOrigin(value, app)).toBe('http://hppt.localhost:5173');
  }
  expect(app).toBe('http://app.hppt.localhost:5173');
});
it('preserves explicitly configured production origins', () => {
  expect(normalizeViewerOrigin('https://sites.example.com', 'https://app.example.com')).toBe('https://sites.example.com');
  expect(normalizeViewerOrigin('https://sites.example.com:8443', 'https://app.example.com:8443')).toBe('https://sites.example.com:8443');
});
