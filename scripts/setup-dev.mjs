import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { normalizeAppOrigin, normalizeViewerOrigin } from './origins.ts';
const args = process.argv.slice(2);
const flag = args.indexOf('--turn-host');
const host = flag < 0 ? undefined : args[flag + 1];
if (flag >= 0 && (!host || !/^[a-zA-Z0-9.-]+$/.test(host))) throw new Error('Expected --turn-host <IPv4 or hostname>');
await mkdir('infra/coturn', { recursive: true });
let text;
try { text = await readFile('.env', 'utf8'); }
catch (e) { if (e.code !== 'ENOENT') throw e; text = await readFile('.env.example', 'utf8'); }
let env = parseEnv(text);
for (const [key, value] of [['APP_ORIGIN', normalizeAppOrigin(env.APP_ORIGIN)], ['VIEWER_ORIGIN', normalizeViewerOrigin(env.VIEWER_ORIGIN)]]) {
  if (env[key]) text = text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
  else text += `\n${key}=${value}\n`;
}
const additions = { TURN_USERNAME: 'htppt-dev', TURN_PASSWORD: randomBytes(24).toString('hex'), LOCAL_UID: String(process.getuid?.() ?? 1000), LOCAL_GID: String(process.getgid?.() ?? 1000) };
for (const [key, value] of Object.entries(additions)) if (!env[key]) text += `\n${key}=${value}\n`;
if (host) text = text.replace(/^TURN_HOST=.*$/m, `TURN_HOST=${host}`);
env = parseEnv(text);
await writeFile('.env', text, { mode: 0o600 });
const config = `listening-port=${env.TURN_PORT}\nlistening-ip=0.0.0.0\nmin-port=49160\nmax-port=49200\nfingerprint\nlt-cred-mech\nrealm=htppt.local\nuser=${env.TURN_USERNAME}:${env.TURN_PASSWORD}\nexternal-ip=${env.TURN_HOST}\n${env.TURN_HOST === '127.0.0.1' ? 'allow-loopback-peers\n' : ''}no-tls\nno-dtls\nno-cli\nno-multicast-peers\nno-tcp-relay\nlog-file=stdout\nsimple-log\n`;
// The config derives from the preserved credential; reruns never rotate secrets.
await writeFile('infra/coturn/turnserver.dev.conf', config, { mode: 0o600 });
console.log(`Development configuration ready. TURN advertises ${env.TURN_HOST}:${env.TURN_PORT}.`);
