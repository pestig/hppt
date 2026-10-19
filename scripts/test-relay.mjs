import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const build = spawnSync('npm', ['run', 'build'], { stdio: 'inherit' });
if (build.status) process.exit(build.status);
const run = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', 'relay.spec.ts'], { stdio: 'inherit', env: { ...process.env, RELAY_TEST: '1' } });
process.exit(run.status ?? 1);
