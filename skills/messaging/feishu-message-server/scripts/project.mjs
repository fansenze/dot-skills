import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// This entry point uses only Node built-ins so setup works before installation.
export function findProject(start = skillRoot) {
  start = fs.realpathSync(start);
  for (let directory = start;; directory = path.dirname(directory)) {
    const lockfile = path.join(directory, 'pnpm-lock.yaml');
    const manifest = path.join(directory, 'package.json');
    const workspace = fs.existsSync(path.join(directory, 'pnpm-workspace.yaml'));
    if (fs.existsSync(lockfile) && fs.existsSync(manifest) && (directory === start || workspace)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      return {directory, lockfile, importer: path.relative(directory, start).split(path.sep).join('/') || '.', packageManager: pkg.packageManager};
    }
    if (path.dirname(directory) === directory) break;
  }
  throw new Error('pnpm-lock.yaml is missing; use a repository checkout or an exported skill archive');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(findProject().directory); }
  catch { console.error('pnpm-lock.yaml is missing; use a repository checkout or an exported skill archive'); process.exitCode = 1; }
}
