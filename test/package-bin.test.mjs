import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
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

function withTimeout(promise, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 10_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function runInstalledBridge(entrypoint) {
  const child = spawn(process.execPath, [entrypoint], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  let ready = false;
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const started = new Promise((resolve, reject) => {
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (!ready && stderr.includes('verboo-bridge ready')) {
        ready = true;
        resolve();
      }
    });
    exited.then(({ code, signal }) => {
      if (!ready) {
        reject(new Error(`bridge encerrou antes de ready (${code ?? signal})`));
      }
    }, reject);
  });

  try {
    await withTimeout(started, 'bridge não anunciou ready em 10s');
    child.stdin.end();
    const { code, signal } = await withTimeout(
      exited,
      'bridge não encerrou após EOF em 10s',
    );
    assert.equal(code, 0, `bridge encerrou com ${code ?? signal}\n${stderr}`);
  } finally {
    if (!child.stdin.destroyed) child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await withTimeout(exited.catch(() => {}), 'bridge não respondeu ao SIGKILL')
      .catch(() => {});
  }
}

async function runNpm(args, options) {
  const candidates = [
    process.env.npm_execpath,
    path.join(
      path.dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
    path.resolve(
      path.dirname(process.execPath),
      '..',
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return execFileAsync(process.execPath, [candidate, ...args], options);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  if (process.platform === 'win32') {
    throw new Error('npm-cli.js não encontrado ao lado do node.exe');
  }
  return execFileAsync('npm', args, options);
}

test('pacote npm executa os bins Node sem shell e preserva o wrapper POSIX', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'verboo-package-'));
  const installPrefix = path.join(temp, 'install');

  const { stdout } = await runNpm(
    ['pack', '--json', '--pack-destination', temp],
    { cwd: path.resolve('.') },
  );
  const [{ filename }] = JSON.parse(stdout);
  await runNpm(
    [
      'install',
      '--ignore-scripts',
      '--prefix',
      installPrefix,
      path.join(temp, filename),
    ],
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

  const manifest = JSON.parse(
    await readFile(path.join(installedPackage, 'package.json'), 'utf8'),
  );
  assert.equal(manifest.bin['verboo-bridge'], 'index.mjs');
  assert.equal(manifest.bin['verboo-mcp'], 'bin/verboo-mcp');
  await execFileAsync(process.execPath, [
    '--check',
    path.join(installedPackage, manifest.bin['verboo-bridge']),
  ]);
  await runInstalledBridge(
    path.join(installedPackage, manifest.bin['verboo-bridge']),
  );

  if (process.platform === 'win32') {
    const installedShim = path.join(
      installPrefix,
      'node_modules',
      '.bin',
      'verboo-bridge.cmd',
    );
    assert.match(
      await readFile(installedShim, 'utf8'),
      /verboo-bridge[\\/]index\.mjs/,
    );
  } else {
    const fakeNode = path.join(temp, 'node');
    await writeFile(fakeNode, '#!/usr/bin/env bash\nprintf "%s\\n" "$1"\n');
    await chmod(fakeNode, 0o755);

    const installedBin = path.join(
      installPrefix,
      'node_modules',
      '.bin',
      'verboo-mcp',
    );
    const result = await execFileAsync(installedBin, [], {
      env: {
        ...process.env,
        VERBOO_API_KEY: 'test-key',
        VERBOO_NODE_BIN: fakeNode,
      },
    });

    assert.equal(
      result.stdout.trim(),
      path.join(
        await realpath(installPrefix),
        'node_modules',
        'verboo-bridge',
        'index.mjs',
      ),
    );
  }

  const instructionsBin = path.join(
    installedPackage,
    manifest.bin['verboo-install-instructions'],
  );
  const instructionsHome = path.join(temp, 'instructions-home');
  const instructionsEnv = {
    ...process.env,
    VERBOO_INSTRUCTIONS_HOME: instructionsHome,
  };
  await execFileAsync(process.execPath, [instructionsBin], {
    env: instructionsEnv,
  });
  await execFileAsync(process.execPath, [instructionsBin], {
    env: instructionsEnv,
  });

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
    execFileAsync(process.execPath, [instructionsBin], { env: instructionsEnv }),
  );
  assert.equal(await readFile(agentsSkill, 'utf8'), 'conteúdo personalizado\n');
  await execFileAsync(process.execPath, [instructionsBin, '--force'], {
    env: instructionsEnv,
  });
  assert.equal(await readFile(agentsSkill, 'utf8'), expectedSkill);
});
