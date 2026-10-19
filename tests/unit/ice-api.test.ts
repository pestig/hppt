import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
const children: ChildProcess[] = [];
const secret = 'fixture-only-not-a-real-turn-secret';
const gateway = 'fixture-only-gateway';
const origin = 'https://app.example';
beforeAll(async () => {
  for (const [port, mode] of [[39101, 'development'], [39102, 'production']] as const) {
    const child = spawn(process.execPath, ['apps/ice-api/main.ts'], { env: { ...process.env, PORT: String(port), APP_ORIGIN: origin, NODE_ENV: mode, TURN_SECRET: secret, AUTH_PROXY_TOKEN: gateway, TURN_USERNAME: 'fixture', TURN_PASSWORD: 'fixture-password' }, stdio: 'ignore' });
    children.push(child);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { ready = (await fetch(`http://localhost:${port}/health`)).status === 200; } catch { /* Wait for the child listener. */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error('ICE API test startup failed');
  }
});
afterAll(async () => { await Promise.all(children.map(child => new Promise<void>(resolve => { if (child.exitCode !== null) { resolve(); return; } child.once('exit', () => resolve()); child.kill(); }))); });
it('restricts origins, methods and credential caching', async () => {
  expect((await fetch('http://localhost:39101/ice', { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
  expect((await fetch('http://localhost:39101/ice', { method: 'POST' })).status).toBe(405);
  const response = await fetch('http://localhost:39101/ice', { headers: { Origin: origin } });
  expect(response.headers.get('access-control-allow-origin')).toBe(origin);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect((await response.json()).iceServers[1].urls.every((url: string) => url.startsWith('turn:'))).toBe(true);
});
it('production refuses untrusted identity and issues bounded HMAC credentials behind a trusted gateway', async () => {
  expect((await fetch('http://localhost:39102/ice')).status).toBe(401);
  expect((await fetch('http://localhost:39102/ice', { headers: { 'x-authenticated-user': 'alice' } })).status).toBe(401);
  const response = await fetch('http://localhost:39102/ice', { headers: { 'x-authenticated-user': 'alice', 'x-htppt-gateway-token': gateway, Origin: origin } });
  const data = await response.json(); const turn = data.iceServers[1];
  expect(turn.username).toBe(`${data.expiresAt}:alice`);
  expect(turn.credential).toBe(createHmac('sha1', secret).update(turn.username).digest('base64'));
  expect(data.expiresAt - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(3600);
});
it('rate limits repeated credential issuance', async () => {
  let response!: Response;
  for (let i = 0; i < 31; i++) response = await fetch('http://localhost:39101/ice');
  expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('60');
});
