import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { normalizeAppOrigin, normalizeViewerOrigin } from './origins.ts';
if (existsSync('.env')) process.loadEnvFile('.env');
const children = [];
const production = process.argv.includes('--production');
const services = process.argv.includes('--services');
function run(args, extra = {}) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, ...extra } });
  children.push(child);
  child.on('exit', code => { if (code && !stopping) { process.exitCode = code; stop(); } });
}
let stopping = false;
function stop() { stopping = true; for (const child of children) child.kill('SIGTERM'); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
if (services) {
  run(['apps/tracker/main.ts'], { PORT: '8000' });
  run(['apps/ice-api/main.ts'], { PORT: '3001' });
} else {
  if (!production) {
    const result = spawnSync('npm', ['run', 'build'], { stdio: 'inherit' });
    if (result.status) process.exit(result.status);
  }
  run(['node_modules/vite/bin/vite.js', 'preview', '--config', 'apps/web/vite.config.ts']);
}
console.log('Web UI:      ' + normalizeAppOrigin(process.env.APP_ORIGIN));
console.log('Viewer host: ' + normalizeViewerOrigin(process.env.VIEWER_ORIGIN, normalizeAppOrigin(process.env.APP_ORIGIN)));
console.log('Tracker:     ' + (process.env.TRACKER_URL || 'ws://localhost:8000'));
console.log('ICE API:     ' + (process.env.ICE_API_URL || 'http://localhost:3001/ice'));
