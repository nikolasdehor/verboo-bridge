import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('vb combina prompt posicional com stdin sem chamada de rede', {
  skip: process.platform === 'win32',
}, async () => {
  const fakeBin = await mkdtemp(path.join(os.tmpdir(), 'verboo-vb-'));
  const fakeCurl = path.join(fakeBin, 'curl');
  await writeFile(
    fakeCurl,
    `#!/usr/bin/env node
const index = process.argv.indexOf('-d');
const body = JSON.parse(process.argv[index + 1]);
process.stdout.write(JSON.stringify({ choices: [{ message: { content: body.messages.at(-1).content } }] }));
`,
  );
  await chmod(fakeCurl, 0o755);

  const result = await new Promise((resolve, reject) => {
    const child = spawn(path.resolve('bin/vb'), ['Revise este código'], {
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        VERBOO_API_KEY: 'test-key',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end('const answer = 42;');
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Revise este código/);
  assert.match(result.stdout, /const answer = 42;/);
});
