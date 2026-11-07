#!/usr/bin/env node
import { readdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const projects = ['packages', 'apps'].flatMap(group => readdirSync(resolve(root, group), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(resolve(root, group, entry.name, 'tsconfig.test.json')))
  .map(entry => `${group}/${entry.name}`));
// Keep diagnostics associated with their project and avoid exhausting memory
// on machines that also run Chromium/container checks in CI.
let next = 0, failed = false;
async function worker() {
  for (;;) {
    const project = projects[next++]; if (!project) return;
    console.log(`Checking test types: ${project}`);
    const status = await new Promise((done, reject) => {
      const child = spawn('pnpm', ['exec', 'tsc', '-p', 'tsconfig.test.json', '--noEmit'], { cwd: resolve(root, project), stdio: 'inherit' });
      child.once('error', reject); child.once('close', done);
    });
    if (status !== 0) failed = true;
  }
}
await Promise.all([worker(), worker(), worker()]);
if (failed) process.exitCode = 1;
