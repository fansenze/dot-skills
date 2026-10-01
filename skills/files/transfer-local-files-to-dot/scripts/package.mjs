#!/usr/bin/env node
/** Export an explicit set of reusable skill files as a deterministic ZIP. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)));
export const FILES = Object.freeze([
  'SKILL.md',
  'agents/openai.yaml',
  'assets/icon.svg',
  'package.json',
  'references/cli.md',
  'references/handoff.md',
  'references/validation.md',
  'scripts/package.mjs',
  'scripts/transfer.mjs',
  'scripts/validate.mjs',
  'tests/transfer.test.mjs',
]);

export function requireNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 18)) throw new Error('Node.js 22.18.0 or newer is required');
}

function outsideSkill(target) {
  const relative = path.relative(ROOT, target);
  if (!relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
    throw new Error('Package output must be outside the skill directory');
  }
}

function physicalParent(target) {
  let current = path.dirname(target);
  const suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      suffix.unshift(path.basename(current));
      current = path.dirname(current);
    }
  }
}

function readSkillFile(relative) {
  let current = ROOT;
  const components = relative.split('/');
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Refusing linked package path: ${relative}`);
    if (index < components.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Package path must be an ordinary file or directory: ${relative}`);
    }
  }
  return fs.readFileSync(current);
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function packageSkill(requested) {
  requireNode();
  const lexical = path.resolve(requested);
  outsideSkill(lexical);
  const target = path.join(physicalParent(lexical), path.basename(lexical));
  outsideSkill(target);
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Existing package output must be an ordinary file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const local = [], central = [];
  let offset = 0;
  for (const relative of FILES) {
    const name = Buffer.from(`transfer-local-files-to-dot/${relative}`);
    const data = readSkillFile(relative), checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(checksum, 14); header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(33, 14); directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((0o100644 << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    local.push(header, name, data); central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(FILES.length, 8); end.writeUInt16LE(FILES.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...local, directory, end]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, zip, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
  return { path: target, files: FILES.length, size_bytes: zip.length, sha256: crypto.createHash('sha256').update(zip).digest('hex') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/package.mjs /path/to/transfer-local-files-to-dot.zip');
    console.log(JSON.stringify(packageSkill(process.argv[2]), null, 2));
  } catch (error) { console.error(`package: ${error.message}`); process.exitCode = 2; }
}
