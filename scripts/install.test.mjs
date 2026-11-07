import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createReleaseBundle } from './release-bundle.mjs';

// Mock only external services/privileged changes; exercise real archive extraction,
// checksum verification, config generation and random secret creation.
async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'owngate-install-test-'));
  try {
    const bin = join(dir, 'bin'); const assets = join(dir, 'assets');
    await mkdir(bin);
    await createReleaseBundle({ version: '0.2.0', owner: 'ChengHongxu', out: assets });
    const commands = {
      uname: 'case "$1" in -s) echo Linux;; -m) echo x86_64;; esac',
      docker: `printf '%s\\n' "$*" >> "$CALLS"
case "$*" in
 'compose version --short') echo 2.24.0;;
 'version --format '*) echo 24.0.0;;
 'volume inspect '*) [ "\$EXISTING_VOLUME" = yes ];;
 'compose pull') [ "\$PULL_FAIL" != yes ];;
 *) exit 0;;
esac`,
      chown: 'exit 0',
      sudo: '[ "$1" = -v ] && exit 0; exec "$@"',
      gh: `if [ "$1" = api ]; then echo v0.2.0; else
while [ "$#" -gt 0 ]; do if [ "$1" = --dir ]; then shift; dest=$1; fi; shift; done
cp "$ASSETS/owngate-deploy-0.2.0.tar.gz" "$ASSETS/SHA256SUMS" "$dest/"
fi`,
      curl: `case "$*" in *releases/latest*) echo https://github.com/ChengHongxu/owngate/releases/tag/v0.2.0;; *)
while [ "$#" -gt 0 ]; do case "$1" in https://*/download/*) asset=\${1##*/};; -o) shift; dest=$1;; esac; shift; done
cp "$ASSETS/$asset" "$dest"
esac`,
    };
    for (const [name, script] of Object.entries(commands)) await writeFile(join(bin, name), `#!/bin/bash\nset -eu\n${script}\n`, { mode: 0o755 });
    const target = join(dir, 'my instance'); const calls = join(dir, 'calls');
    const invoke = (args = [], env = {}) => spawnSync('bash', [resolve('deploy/install.sh'), '--yes', '--dir', target, ...args], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ASSETS: assets, CALLS: calls, EXISTING_VOLUME: 'no', PULL_FAIL: 'no', ...env }, timeout: 15000,
    });
    const interact = () => spawnSync('python3', ['-c', `
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execv('/bin/bash', ['bash', '-c', 'cat "$1" | bash -s -- --dir "$2"', 'test', sys.argv[1], sys.argv[2]])
output = b''
count = 0
deadline = time.monotonic() + 15
while time.monotonic() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        output += data
        prompts = output.count(']：'.encode())
        # Send each answer only after its prompt; the fifth declines startup.
        if prompts > count:
            count = prompts
            os.write(fd, b'n\\n' if count == 5 else b'\\n')
else:
    os.kill(pid, 9)
_, status = os.waitpid(pid, 0)
print(output.decode(errors='replace'))
sys.exit(os.waitstatus_to_exitcode(status))
`, resolve('deploy/install.sh'), target], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ASSETS: assets, CALLS: calls, EXISTING_VOLUME: 'no', PULL_FAIL: 'no' }, timeout: 20000,
    });
    await run({ invoke, interact, target, calls, assets });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('public latest install writes minimal configuration and four private, unique secrets; repeat refuses', () => fixture(async ({ invoke, target, calls }) => {
  const result = invoke(['--port', '3300']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(join(target, '.env'), 'utf8'), /PORT=3300\nBIND_HOST=127.0.0.1\nOWNGATE_ORIGIN=http:\/\/localhost:3300/);
  const secrets = await readdir(join(target, 'secrets'));
  assert.equal(secrets.length, 4);
  const values = await Promise.all(secrets.map(name => readFile(join(target, 'secrets', name), 'utf8')));
  assert.equal(new Set(values).size, 4);
  for (const name of secrets) {
    assert.match(await readFile(join(target, 'secrets', name), 'utf8'), /^[0-9a-f]{64}\n$/);
    assert.equal((await stat(join(target, 'secrets', name))).mode & 0o777, 0o600);
  }
  assert.doesNotMatch(await readFile(calls, 'utf8'), /compose (pull|up)/);
  assert.notEqual(invoke().status, 0);
  assert.equal(await readFile(join(target, 'secrets', secrets[0]), 'utf8'), values[0]);
}));

test('private explicit release configures HTTPS and starts on request', () => fixture(async ({ invoke, target, calls }) => {
  const result = invoke(['--private', '--version', 'v0.2.0', '--origin', 'https://gate.example.com', '--start']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(join(target, '.env'), 'utf8'), /OWNGATE_RP_ID=gate.example.com/);
  assert.match(await readFile(calls, 'utf8'), /compose pull\ncompose up -d\ncompose ps/);
}));

test('failed pull keeps generated secrets and config for a manual retry', () => fixture(async ({ invoke, target, calls }) => {
  const result = invoke(['--start'], { PULL_FAIL: 'yes' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /配置已保留/);
  assert.equal((await readdir(join(target, 'secrets'))).length, 4);
  assert.doesNotMatch(await readFile(calls, 'utf8'), /compose up/);
}));

test('corrupt archive, existing volumes, unsafe input and existing files cannot create secrets', () => fixture(async ({ invoke, target, assets }) => {
  for (const args of [['--port', '0'], ['--origin', 'https://x.test/\nEVIL=1'], ['--version', '../x']]) assert.notEqual(invoke(args).status, 0);
  assert.notEqual(invoke([], { EXISTING_VOLUME: 'yes' }).status, 0);
  await assert.rejects(stat(target));
  await writeFile(join(assets, 'owngate-deploy-0.2.0.tar.gz'), 'corrupt');
  const result = invoke();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /校验失败/);
  await assert.rejects(stat(target));
  await mkdir(target);
  await writeFile(join(target, '.env'), 'keep');
  assert.notEqual(invoke().status, 0);
  assert.equal(await readFile(join(target, '.env'), 'utf8'), 'keep');
}));


test('piped installer reads real interactive answers from the terminal', () => fixture(async ({ interact, target, calls }) => {
  const result = interact();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(await readFile(join(target, '.env'), 'utf8'), /OWNGATE_ORIGIN=http:\/\/localhost:3000/);
  assert.doesNotMatch(await readFile(calls, 'utf8'), /compose (pull|up)/);
}));
