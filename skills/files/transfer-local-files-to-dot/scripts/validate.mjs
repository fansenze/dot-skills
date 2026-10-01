#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { FILES, ROOT, requireNode } from './package.mjs';

requireNode();
for (const relative of FILES) {
  const stat = fs.lstatSync(path.join(ROOT, relative));
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `Missing or linked skill file: ${relative}`);
  if (relative.endsWith('.mjs')) {
    const checked = spawnSync(process.execPath, ['--check', path.join(ROOT, relative)], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr || `Syntax check failed: ${relative}`);
  }
}
const skill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
assert.ok(frontmatter, 'SKILL.md must start with YAML frontmatter');
assert.match(frontmatter[1], /^name: transfer-local-files-to-dot$/m);
const description = frontmatter[1].match(/^description: (.+)$/m)?.[1];
assert.ok(description && description.length <= 1024 && !/[<>]/.test(description));
const metadata = fs.readFileSync(path.join(ROOT, 'agents/openai.yaml'), 'utf8');
assert.ok(metadata.includes('$transfer-local-files-to-dot'));
const shortDescription = metadata.match(/^  short_description: "([^"]+)"$/m)?.[1];
assert.ok(shortDescription && shortDescription.length >= 25 && shortDescription.length <= 64);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'transfer-local-files-to-dot-skill');
assert.equal(pkg.engines.node, '>=22.18.0');
assert.equal(pkg.type, 'module');
assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
for (const relative of FILES.filter(file => file.endsWith('.md'))) {
  const markdown = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  for (const match of markdown.matchAll(/\]\(([^\s)]+)\)/g)) {
    if (/^(?:[a-z]+:|#)/i.test(match[1])) continue;
    const linked = path.resolve(ROOT, path.dirname(relative), match[1].split('#')[0]);
    assert.ok(fs.existsSync(linked), `Broken relative link in ${relative}: ${match[1]}`);
  }
}
console.log(JSON.stringify({ ok: true, skill: 'transfer-local-files-to-dot', portable_files: FILES.length, runtime: 'node' }));
