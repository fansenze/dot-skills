import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { ROOT } from './config.mjs';
import { FILES } from './package.mjs';
import { findProject } from './project.mjs';

const skill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
const match = skill.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
assert.ok(match, 'SKILL.md must begin with YAML frontmatter');
const front = parse(match[1]);
assert.equal(front.name, 'feishu-message-server');
assert.ok(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(front.name) && front.name.length <= 64);
assert.ok(typeof front.description === 'string' && front.description.length > 20 && front.description.length <= 1024);
assert.ok(!/[<>]/.test(front.description));
assert.ok(Object.keys(front).every(k => ['name', 'description', 'license', 'allowed-tools', 'metadata'].includes(k)));
const metadata = parse(fs.readFileSync(path.join(ROOT, 'agents/openai.yaml'), 'utf8'));
assert.ok(metadata.interface.default_prompt.includes('$feishu-message-server'));
assert.ok(metadata.interface.short_description.length >= 25 && metadata.interface.short_description.length <= 64);
const example = parse(fs.readFileSync(path.join(ROOT, 'config.example.yml'), 'utf8'));
assert.deepEqual(example, {app_id: '', app_secret: ''});
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json')));
const project = findProject();
assert.match(project.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
const lock = parse(fs.readFileSync(project.lockfile, 'utf8'));
const importer = lock.importers?.[project.importer];
assert.ok(importer, 'The pnpm lockfile must include this skill');
assert.deepEqual(Object.keys(pkg.dependencies).sort(), Object.keys(importer.dependencies).sort());
for (const [name, version] of Object.entries(pkg.dependencies)) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(importer.dependencies[name].specifier, version);
  assert.equal(importer.dependencies[name].version.split('(')[0], version);
  assert.ok(lock.packages[`${name}@${version}`]);
}
for (const name of FILES) {
  assert.ok(fs.lstatSync(path.join(ROOT, name)).isFile(), `Missing or linked: ${name}`);
  const content = fs.readFileSync(path.join(ROOT, name), 'utf8');
  assert.ok(!/\/Users\/[^/]+\/|C:\\\\Users\\\\|\/home\/[^/]+\//.test(content), `Personal path in ${name}`);
  assert.ok(!/(?:https:\/\/[^\s"']*(?:hook|webhook)[^\s"']*\/[A-Za-z0-9_-]{20,})/.test(content), `Webhook in ${name}`);
  assert.ok(!/cli_(?!0000000000000000)[a-fA-F0-9]{16}/.test(content), `App ID in ${name}`);
  assert.ok(!/\.(?:py|pyc)$/.test(name));
}
console.log(JSON.stringify({ok: true, skill: front.name, portable_files: FILES.length, runtime: 'node'}));
