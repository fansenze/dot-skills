import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ROOT, SafeError } from './config.mjs';

export const FILES = Object.freeze([
  'SKILL.md', 'agents/openai.yaml', 'config.example.yml', 'feishu.sh',
  'package.json', 'package-lock.json', 'scripts/config.mjs', 'scripts/messages.mjs',
  'scripts/transport.mjs', 'scripts/runtime.mjs', 'scripts/server.mjs',
  'scripts/package.mjs', 'scripts/validate.mjs', 'tests/server.test.mjs',
  'tests/transport.test.mjs', 'references/operations.md', 'references/validation.md'
]);

export function makePackage(destination = path.join(ROOT, 'dist', 'feishu-message-server-node.tgz')) {
  const target = path.resolve(destination);
  if (fs.existsSync(target)) throw new SafeError('Archive already exists; choose a new output path');
  fs.mkdirSync(path.dirname(target), {recursive: true});
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-node-package-'));
  const folder = path.join(staging, 'feishu-message-server');
  try {
    for (const name of FILES) {
      const source = path.join(ROOT, name), output = path.join(folder, name);
      if (!fs.lstatSync(source).isFile()) throw new SafeError('Package input must be a regular file');
      fs.mkdirSync(path.dirname(output), {recursive: true});
      fs.copyFileSync(source, output, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(output, name === 'feishu.sh' ? 0o755 : 0o644);
    }
    const result = spawnSync('tar', ['-czf', target, '-C', staging, 'feishu-message-server'], {stdio: 'pipe', shell: false});
    if (result.status !== 0) { fs.rmSync(target, {force: true}); throw new SafeError('Packaging failed; tar is required'); }
    return target;
  } finally { fs.rmSync(staging, {recursive: true, force: true}); }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify({ok: true, archive: makePackage(process.argv[2]), files: FILES.length})); }
  catch (error) { console.error(JSON.stringify({ok: false, error: error instanceof SafeError ? error.message : 'Packaging failed'})); process.exitCode = 1; }
}
