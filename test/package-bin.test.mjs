import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
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

  const installedPackage = path.join(
    installPrefix,
    'node_modules',
    'verboo-bridge',
  );
  await Promise.all([
    access(path.join(installedPackage, 'job-queue.mjs')),
    access(path.join(installedPackage, 'memory-store.mjs')),
  ]);

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

  const instructionsBin = path.join(
    installPrefix,
    'node_modules',
    '.bin',
    'verboo-install-instructions',
  );
  const instructionsHome = path.join(temp, 'instructions-home');
  const instructionsEnv = {
    ...process.env,
    VERBOO_INSTRUCTIONS_HOME: instructionsHome,
  };
  await execFileAsync(instructionsBin, [], { env: instructionsEnv });
  await execFileAsync(instructionsBin, [], { env: instructionsEnv });

  const expectedSkill = await readFile(
    path.join(installedPackage, 'skills', 'verboo-executor', 'SKILL.md'),
    'utf8',
  );
  for (const clientDir of ['.agents', '.claude', '.cursor']) {
    const installedSkill = await readFile(
      path.join(instructionsHome, clientDir, 'skills', 'verboo-executor', 'SKILL.md'),
      'utf8',
    );
    assert.equal(installedSkill, expectedSkill);
  }

  const agentsSkill = path.join(
    instructionsHome,
    '.agents',
    'skills',
    'verboo-executor',
    'SKILL.md',
  );
  await writeFile(agentsSkill, 'conteúdo personalizado\n');
  await assert.rejects(
    execFileAsync(instructionsBin, [], { env: instructionsEnv }),
  );
  assert.equal(await readFile(agentsSkill, 'utf8'), 'conteúdo personalizado\n');
  await execFileAsync(instructionsBin, ['--force'], { env: instructionsEnv });
  assert.equal(await readFile(agentsSkill, 'utf8'), expectedSkill);
});
