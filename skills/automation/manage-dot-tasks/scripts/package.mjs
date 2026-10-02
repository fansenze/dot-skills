#!/usr/bin/env node
/** Deterministic, dependency-free ZIP packaging; no external archiver required. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomic_write, canonical_path, is_main, require_node, TaskError } from './taskctl.mjs';

const root = canonical_path(path.dirname(fileURLToPath(import.meta.url)) + '/..');
const allowedRoots = new Set(['SKILL.md', 'package.json', 'agents', 'assets', 'references', 'scripts', 'tests', 'ui']);
function files(dir = root, relative = '') {
  const output = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (['.DS_Store', '__pycache__'].includes(entry.name)) continue;
    if (!relative && !allowedRoots.has(entry.name)) throw new TaskError(`unexpected package entry: ${entry.name}`);
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new TaskError(`refusing symlink: ${rel}`);
    if (entry.isDirectory()) output.push(...files(path.join(dir, entry.name), rel));
    else if (entry.isFile()) {
      if (/\.py[cod]?$/.test(entry.name)) throw new TaskError(`remove legacy runtime from the active skill before packaging: ${rel}`);
      output.push(rel);
    } else throw new TaskError(`unsupported package entry: ${rel}`);
  }
  return output;
}
const table = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(data) { let crc = 0xffffffff; for (const b of data) crc = table[(crc ^ b) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
export function skill_entries() {
  return files().map(rel => ({name: `manage-dot-tasks/${rel}`, data: fs.readFileSync(path.join(root, rel))}));
}
export function package_skill(target) {
  require_node();
  target = canonical_path(target);
  const rel = path.relative(root, target);
  if (!rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))) throw new TaskError('package output must be outside the skill');
  return package_entries(target, skill_entries());
}
export function package_entries(target, entries) {
  if (new Set(entries.map(e => e.name)).size !== entries.length || entries.some(e => !e.name || e.name.startsWith('/') || e.name.split('/').some(p => p === '..' || p === '.' || !p))) throw new TaskError('invalid archive entry');
  const local = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data), checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(checksum, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(33, 14); directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    local.push(header, name, data); central.push(directory, name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...local, directory, end]);
  atomic_write(target, zip);
  return { path: target, files: entries.length, size_bytes: zip.length, sha256: crypto.createHash('sha256').update(zip).digest('hex') };
}
if (is_main(import.meta.url)) {
  try { if (process.argv.length !== 3) throw new TaskError('Usage: node package.mjs /absolute/output/manage-dot-tasks.zip'); process.stdout.write(JSON.stringify(package_skill(process.argv[2]), null, 2) + '\n'); }
  catch (error) { process.stderr.write(`package: ${error.message}\n`); process.exitCode = 2; }
}
