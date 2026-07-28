#!/usr/bin/env node

import { constants } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(packageRoot, 'skills', 'verboo-executor', 'SKILL.md');
const home = process.env.VERBOO_INSTRUCTIONS_HOME || os.homedir();
const force = process.argv.includes('--force');
const targets = [
  path.join(home, '.agents', 'skills', 'verboo-executor', 'SKILL.md'),
  path.join(home, '.claude', 'skills', 'verboo-executor', 'SKILL.md'),
  path.join(home, '.cursor', 'skills', 'verboo-executor', 'SKILL.md'),
];
const expected = await readFile(source);
let conflicted = false;

for (const target of targets) {
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL);
    console.log(`Instalada: ${target}`);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const current = await readFile(target);
    if (current.equals(expected)) {
      console.log(`Já instalada: ${target}`);
    } else if (force) {
      await copyFile(source, target);
      console.log(`Atualizada: ${target}`);
    } else {
      conflicted = true;
      console.error(`Não sobrescrita: ${target} já existe com conteúdo diferente.`);
    }
  }
}

if (conflicted) process.exitCode = 1;
