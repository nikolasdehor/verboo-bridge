import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('verboo-mcp instalado por npm resolve index.mjs a partir do pacote real', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'verboo-package-'));
  const installPrefix = path.join(temp, 'install');
  const fakeNode = path.join(temp, 'node');
  await writeFile(fakeNode, '#!/usr/bin/env bash\nprintf "%s\\n" "$1"\n');
  await chmod(fakeNode, 0o755);

  const { stdout } = await execFileAsync(
    'npm',
    ['pack', '--json', '--pack-destination', temp],
    { cwd: path.resolve('.') },
  );
  const [{ filename }] = JSON.parse(stdout);
  await execFileAsync(
    'npm',
    ['install', '--ignore-scripts', '--prefix', installPrefix, path.join(temp, filename)],
  );

  const installedBin = path.join(installPrefix, 'node_modules', '.bin', 'verboo-mcp');
  const result = await execFileAsync(installedBin, [], {
    env: {
      ...process.env,
      VERBOO_API_KEY: 'test-key',
      VERBOO_NODE_BIN: fakeNode,
    },
  });

  assert.equal(
    result.stdout.trim(),
    path.join(await realpath(installPrefix), 'node_modules', 'verboo-bridge', 'index.mjs'),
  );
});
