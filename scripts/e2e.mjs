import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const build = spawnSync('npm', ['run', 'build'], { stdio: 'inherit' });
if (build.status) process.exit(build.status);
const test = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
process.exit(test.status ?? 1);
