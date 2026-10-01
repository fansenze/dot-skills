#!/usr/bin/env node
// Filesystem-only transfer packaging. No network, credentials, or platform API.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const FORMAT = 'dot-transfer-1';
const MANIFEST = '.dot-transfer-manifest.json';
const MAX = Object.freeze({ entries: 10000, bytes: 200 * 1024 * 1024, file: 100 * 1024 * 1024, manifest: 4 * 1024 * 1024, depth: 32, archive: 216 * 1024 * 1024 });
const SHA = /^[a-f0-9]{64}$/;
class TransferError extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new TransferError(code, message); };
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const integer = x => Number.isSafeInteger(x) && x >= 0;
function exactKeys(o, keys) { if (!plain(o) || Object.keys(o).sort().join(',') !== [...keys].sort().join(',')) fail('INVALID_MANIFEST', 'Unexpected object fields'); }
function safeName(p) {
  if (typeof p !== 'string' || !p || p.includes('\\') || /[\x00-\x1f\x7f]/.test(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.normalize('NFC') !== p) fail('UNSAFE_PATH', 'Paths must be normalized relative UTF-8 names');
  const parts = p.split('/');
  if (parts.length > MAX.depth || parts.some(s => !s || s === '.' || s === '..' || /[<>:"|?*]/.test(s) || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) fail('UNSAFE_PATH', 'Unsupported or unsafe path component');
  if (Buffer.byteLength(p) > 240 || parts.some(s => Buffer.byteLength(s) > 100)) fail('LIMIT_EXCEEDED', 'Path is too long for the portable archive format');
  return p;
}
function rejectSensitiveName(p) {
  const parts = p.toLowerCase().split('/');
  if (parts.some(s => /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.git|\.npmrc|\.netrc|\.pypirc|\.docker|\.config|\.codex|\.agents|\.git-credentials|credentials(?:\.[^.]+)?|secrets?(?:\.[^.]+)?|id_rsa|id_ed25519|keychain|login data|cookies|local state)$/.test(s) || /\.(?:pem|key|p12|pfx|kdbx)$/.test(s))) fail('SENSITIVE_PATH', `Credential/configuration path excluded: ${p}`);
}
function splitTarName(p) {
  if (Buffer.byteLength(p) <= 100) return { name: p, prefix: '' };
  const i = p.lastIndexOf('/');
  if (i < 0 || Buffer.byteLength(p.slice(0, i)) > 155 || Buffer.byteLength(p.slice(i + 1)) > 100) fail('LIMIT_EXCEEDED', 'Path cannot be represented safely');
  return { prefix: p.slice(0, i), name: p.slice(i + 1) };
}
function header(p, size, type) {
  const h = Buffer.alloc(512); const { name, prefix } = splitTarName(p);
  h.write(name, 0, 100, 'utf8'); h.write(prefix, 345, 155, 'utf8');
  const oct = (v, at, n) => h.write(v.toString(8).padStart(n - 1, '0') + '\0', at, n, 'ascii');
  oct(type === '5' ? 0o755 : 0o644, 100, 8); oct(0, 108, 8); oct(0, 116, 8); oct(size, 124, 12); oct(0, 136, 12);
  h.fill(32, 148, 156); h.write(type, 156, 1); h.write('ustar\0', 257, 6); h.write('00', 263, 2);
  const sum = h.reduce((a, b) => a + b, 0); h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}
function addTar(parts, p, bytes, type = '0') { parts.push(header(p, bytes.length, type), bytes); if (bytes.length % 512) parts.push(Buffer.alloc(512 - bytes.length % 512)); }
async function freshDir(requested) {
  if (!path.isAbsolute(requested)) fail('INVALID_ARGUMENT', 'Output directory must be absolute');
  const parent = await fs.realpath(path.dirname(requested)); const dst = path.join(parent, path.basename(requested));
  try { await fs.mkdir(dst, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') fail('DESTINATION_EXISTS', 'Choose a new destination; overwrites are never enabled'); throw e; }
  return dst;
}
async function readRegular(p, max) {
  const before = await fs.lstat(p);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('UNSAFE_FILE', 'Only ordinary, non-linked regular files are supported');
  if (before.size > max) fail('LIMIT_EXCEEDED', 'File exceeds the size limit');
  const f = await fs.open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await f.stat();
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs) fail('SOURCE_CHANGED', 'Source changed while being read');
    const chunks = []; let n = 0;
    while (true) { const b = Buffer.alloc(Math.min(1024 * 1024, max - n + 1)); const { bytesRead } = await f.read(b, 0, b.length, null); if (!bytesRead) break; n += bytesRead; if (n > max) fail('LIMIT_EXCEEDED', 'File grew beyond the size limit'); chunks.push(b.subarray(0, bytesRead)); }
    const after = await f.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || n !== stat.size) fail('SOURCE_CHANGED', 'Source changed while being read');
    return Buffer.concat(chunks);
  } finally { await f.close(); }
}
async function collect(source, root) {
  const entries = []; const bodies = new Map(); const names = new Set(); let total = 0;
  async function visit(full, relative) {
    safeName(relative); rejectSensitiveName(relative);
    const folded = relative.toLowerCase(); if (names.has(folded)) fail('DUPLICATE_PATH', 'Case-insensitive duplicate path'); names.add(folded);
    if (entries.length >= MAX.entries) fail('LIMIT_EXCEEDED', 'Too many entries');
    const st = await fs.lstat(full);
    if (st.isSymbolicLink()) fail('SYMLINK_REJECTED', `Symlink rejected: ${relative}`);
    if (st.isDirectory()) {
      entries.push({ path: relative, type: 'directory', size: 0 });
      const children = (await fs.readdir(full)).sort();
      for (const name of children) await visit(path.join(full, name), `${relative}/${name}`);
      const after = await fs.lstat(full);
      if (after.ino !== st.ino || after.dev !== st.dev || after.mtimeMs !== st.mtimeMs || after.isSymbolicLink()) fail('SOURCE_CHANGED', 'Source directory changed during packaging');
    } else if (st.isFile()) {
      const b = await readRegular(full, Math.min(MAX.file, MAX.bytes - total));
      total += b.length; entries.push({ path: relative, type: 'file', size: b.length, sha256: digest(b) }); bodies.set(relative, b);
    } else fail('UNSAFE_FILE', `Special file rejected: ${relative}`);
  }
  await visit(source, root); return { entries, bodies, total };
}
export async function pack(source, output) {
  if (!path.isAbsolute(source) || !path.isAbsolute(output)) fail('INVALID_ARGUMENT', 'Source and output must be absolute');
  if (source.split(path.sep).some(part => part === '.' || part === '..')) fail('UNSAFE_PATH', 'Source traversal components are not allowed');
  const normalized = path.resolve(source);
  rejectSensitiveName(normalized.slice(path.parse(normalized).root.length).split(path.sep).join('/'));
  let ancestor = path.parse(normalized).root;
  for (const component of normalized.slice(ancestor.length).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, component);
    const st = await fs.lstat(ancestor);
    const systemAlias = process.platform === 'darwin' && ['/tmp', '/var', '/etc'].includes(ancestor) && ancestor !== normalized;
    if (st.isSymbolicLink() && !systemAlias) fail('SYMLINK_REJECTED', 'Source symlink or symlink ancestor rejected');
  }
  const real = await fs.realpath(normalized); const root = path.basename(real); safeName(root); rejectSensitiveName(root);
  if (root.toLowerCase() === MANIFEST.toLowerCase()) fail('UNSAFE_PATH', 'Source name is reserved for transfer metadata');
  const outputParent = await fs.realpath(path.dirname(output)); const physicalOutput = path.join(outputParent, path.basename(output));
  if (physicalOutput === real || physicalOutput.startsWith(real + path.sep)) fail('INVALID_ARGUMENT', 'Package destination must be outside the source');
  const { entries, bodies, total } = await collect(real, root);
  const manifest = { format: FORMAT, root, total_bytes: total, entries }; const m = Buffer.from(JSON.stringify(manifest) + '\n');
  if (m.length > MAX.manifest) fail('LIMIT_EXCEEDED', 'Manifest too large');
  const parts = []; addTar(parts, MANIFEST, m);
  for (const e of entries) addTar(parts, e.path, bodies.get(e.path) ?? Buffer.alloc(0), e.type === 'directory' ? '5' : '0');
  parts.push(Buffer.alloc(1024)); const archive = Buffer.concat(parts);
  if (archive.length > MAX.archive) fail('LIMIT_EXCEEDED', 'Archive too large');
  const dst = await freshDir(output);
  try {
    const archivePath = path.join(dst, 'transfer.tar'); await fs.writeFile(archivePath, archive, { flag: 'wx', mode: 0o600 });
    const receipt = { status: 'packaged', format: FORMAT, archive_path: archivePath, archive_bytes: archive.length, archive_sha256: digest(archive), root, entry_count: entries.length, file_count: entries.filter(e => e.type === 'file').length, total_bytes: total };
    await fs.writeFile(path.join(dst, 'manifest.json'), m, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(dst, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return receipt;
  } catch (e) { await fs.rm(dst, { recursive: true, force: true }); throw e; }
}
function cstr(b) { const i = b.indexOf(0); if (i >= 0 && b.subarray(i).some(x => x !== 0)) fail('INVALID_ARCHIVE', 'Malformed string field'); const raw = i < 0 ? b : b.subarray(0, i); const s = raw.toString('utf8'); if (!Buffer.from(s).equals(raw)) fail('INVALID_ARCHIVE', 'Invalid UTF-8'); return s; }
function octal(b) { const s = b.toString('ascii').replace(/[\0 ]+$/, ''); if (!/^[0-7]+$/.test(s)) fail('INVALID_ARCHIVE', 'Invalid numeric field'); const n = Number.parseInt(s, 8); if (!integer(n)) fail('INVALID_ARCHIVE', 'Invalid numeric range'); return n; }
function parseTar(bytes) {
  let off = 0; const items = []; const names = new Set();
  while (off + 512 <= bytes.length) {
    const h = bytes.subarray(off, off + 512); off += 512;
    if (h.every(x => x === 0)) { if (bytes.length - off !== 512 || bytes.subarray(off).some(x => x !== 0)) fail('INVALID_ARCHIVE', 'Archive must have exactly two zero end blocks'); return items; }
    const expected = octal(h.subarray(148, 156)); const copy = Buffer.from(h); copy.fill(32, 148, 156);
    if (copy.reduce((a, b) => a + b, 0) !== expected) fail('INVALID_ARCHIVE', 'Tar checksum mismatch');
    if (!h.subarray(257, 263).equals(Buffer.from('ustar\0')) || h.toString('ascii', 263, 265) !== '00') fail('INVALID_ARCHIVE', 'Only bounded USTAR archives are supported');
    const type = h.toString('ascii', 156, 157); if (!['0', '5'].includes(type)) fail('UNSAFE_ARCHIVE_ENTRY', 'Links, extensions, devices and special entries are rejected');
    if (h.subarray(157, 257).some(x => x !== 0)) fail('UNSAFE_ARCHIVE_ENTRY', 'Link target field is not allowed');
    const name = cstr(h.subarray(0, 100)); const prefix = cstr(h.subarray(345, 500)); const p = safeName(prefix ? `${prefix}/${name}` : name);
    const folded = p.toLowerCase(); if (names.has(folded)) fail('DUPLICATE_PATH', 'Duplicate archive path'); names.add(folded);
    if (items.length >= MAX.entries + 1) fail('LIMIT_EXCEEDED', 'Too many archive entries');
    const size = octal(h.subarray(124, 136)); if (size > (p === MANIFEST ? MAX.manifest : MAX.file) || (type === '5' && size !== 0)) fail('LIMIT_EXCEEDED', 'Invalid or oversized archive entry');
    if (!h.equals(header(p, size, type))) fail('INVALID_ARCHIVE', 'Archive header is not the canonical helper format');
    const end = off + size; const next = off + Math.ceil(size / 512) * 512;
    if (next > bytes.length || bytes.subarray(end, next).some(x => x !== 0)) fail('INVALID_ARCHIVE', 'Truncated entry or invalid padding');
    items.push({ path: p, type: type === '5' ? 'directory' : 'file', bytes: bytes.subarray(off, end) }); off = next;
  }
  fail('INVALID_ARCHIVE', 'Missing archive terminator');
}
function validateManifest(items) {
  if (!items.length || items[0].path !== MANIFEST || items[0].type !== 'file') fail('INVALID_MANIFEST', 'First entry must be the transfer manifest');
  let m; try { m = JSON.parse(items[0].bytes.toString('utf8')); } catch { fail('INVALID_MANIFEST', 'Manifest is not valid JSON'); }
  exactKeys(m, ['format', 'root', 'total_bytes', 'entries']);
  if (m.format !== FORMAT || !integer(m.total_bytes) || m.total_bytes > MAX.bytes || !Array.isArray(m.entries) || !m.entries.length || m.entries.length > MAX.entries || items.length !== m.entries.length + 1) fail('INVALID_MANIFEST', 'Invalid manifest limits or entry count');
  safeName(m.root); rejectSensitiveName(m.root); if (m.root.includes('/') || m.root === MANIFEST) fail('INVALID_MANIFEST', 'Invalid root');
  const known = new Map(); let total = 0;
  for (let i = 0; i < m.entries.length; i++) {
    const e = m.entries[i]; if (!plain(e)) fail('INVALID_MANIFEST', 'Invalid entry');
    exactKeys(e, e.type === 'file' ? ['path', 'type', 'size', 'sha256'] : ['path', 'type', 'size']); safeName(e.path); rejectSensitiveName(e.path);
    if (!['file', 'directory'].includes(e.type) || !integer(e.size) || e.size > MAX.file || (e.type === 'directory' && e.size !== 0) || (e.type === 'file' && !SHA.test(e.sha256))) fail('INVALID_MANIFEST', 'Invalid entry fields');
    if (i === 0 ? e.path !== m.root : !e.path.startsWith(m.root + '/')) fail('INVALID_MANIFEST', 'All entries must belong to one root');
    if (i > 0 && known.get(path.posix.dirname(e.path).toLowerCase()) !== 'directory') fail('INVALID_MANIFEST', 'Parent directory is missing, unordered, or not a directory');
    if (known.has(e.path.toLowerCase())) fail('DUPLICATE_PATH', 'Manifest duplicate'); known.set(e.path.toLowerCase(), e.type);
    const item = items[i + 1];
    if (item.path !== e.path || item.type !== e.type || item.bytes.length !== e.size) fail('INTEGRITY_MISMATCH', 'Archive entries do not match the manifest');
    if (e.type === 'file') { if (digest(item.bytes) !== e.sha256) fail('INTEGRITY_MISMATCH', `File checksum mismatch: ${e.path}`); }
    total += e.size; if (total > MAX.bytes) fail('LIMIT_EXCEEDED', 'Expanded bytes exceed limit');
  }
  if (total !== m.total_bytes) fail('INTEGRITY_MISMATCH', 'Total byte count mismatch'); return m;
}
export async function verify(archivePath, expectedSha, expectedBytes) {
  if (typeof expectedSha !== 'string' || !SHA.test(expectedSha) || !integer(expectedBytes) || expectedBytes > MAX.archive) fail('INVALID_ARGUMENT', 'Expected producer SHA-256 and archive bytes are required');
  const archive = await readRegular(archivePath, MAX.archive);
  if (archive.length !== expectedBytes || digest(archive) !== expectedSha) fail('INTEGRITY_MISMATCH', 'Archive differs from the producer receipt');
  const items = parseTar(archive); const manifest = validateManifest(items);
  return { status: 'verified', archive_sha256: expectedSha, archive_bytes: archive.length, manifest, items };
}
export async function extract(archivePath, expectedSha, expectedBytes, destination) {
  const v = await verify(archivePath, expectedSha, expectedBytes); const dst = await freshDir(destination);
  try {
    for (const item of v.items.slice(1)) {
      const target = path.join(dst, ...item.path.split('/'));
      const parent = await fs.realpath(path.dirname(target));
      if (parent !== dst && !parent.startsWith(dst + path.sep)) fail('UNSAFE_PATH', 'Extraction parent escaped destination');
      if (item.type === 'directory') await fs.mkdir(target, { mode: 0o700 });
      else { await fs.writeFile(target, item.bytes, { flag: 'wx', mode: 0o600 }); const actual = await readRegular(target, MAX.file); if (!actual.equals(item.bytes)) fail('INTEGRITY_MISMATCH', 'Written file verification failed'); }
    }
    return { status: 'materialized_and_verified', consumer_local_root: path.join(dst, v.manifest.root), destination: dst, archive_sha256: v.archive_sha256, archive_bytes: v.archive_bytes, entry_count: v.manifest.entries.length, file_count: v.manifest.entries.filter(e => e.type === 'file').length, total_bytes: v.manifest.total_bytes };
  } catch (e) { await fs.rm(dst, { recursive: true, force: true }); throw e; }
}
function parseArgs(argv) {
  const [command, ...rest] = argv; const allowed = { pack: ['source', 'output'], verify: ['archive', 'sha256', 'bytes'], extract: ['archive', 'sha256', 'bytes', 'destination'] };
  if (!allowed[command]) fail('INVALID_ARGUMENT', 'Use pack, verify, or extract. Run --help for usage.');
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) { const k = rest[i]?.replace(/^--/, ''); const val = rest[i + 1]; if (!rest[i]?.startsWith('--') || !allowed[command].includes(k) || Object.hasOwn(opts, k) || val === undefined || val.startsWith('--')) fail('INVALID_ARGUMENT', 'Unknown, duplicate, or missing option'); opts[k] = val; }
  for (const k of allowed[command]) if (!Object.hasOwn(opts, k)) fail('INVALID_ARGUMENT', `Missing --${k}`);
  if (opts.bytes !== undefined && !/^(0|[1-9][0-9]*)$/.test(opts.bytes)) fail('INVALID_ARGUMENT', 'Bytes must be an unsigned decimal integer');
  return { command, opts };
}
async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 18)) fail('UNSUPPORTED_RUNTIME', 'Node.js 22.18.0 or newer is required');
  if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) { console.log('Filesystem-only CLI. Node.js 22.18+. No upload/download capability.\npack --source ABSOLUTE_PATH --output NEW_ABSOLUTE_DIRECTORY\nverify --archive PATH --sha256 PRODUCER_SHA256 --bytes PRODUCER_ARCHIVE_BYTES\nextract --archive PATH --sha256 PRODUCER_SHA256 --bytes PRODUCER_ARCHIVE_BYTES --destination NEW_ABSOLUTE_DIRECTORY\nLimits: 10,000 entries; 200 MiB total; 100 MiB per file; depth 32. No symlinks, hardlinks, sensitive paths, overwrite, or secret bypass. Payload bytes are opaque: no content scan, semantic parsing, or value changes.'); return; }
  const { command, opts: o } = parseArgs(process.argv.slice(2)); let result;
  if (command === 'pack') result = await pack(o.source, o.output);
  else if (command === 'extract') result = await extract(o.archive, o.sha256, Number(o.bytes), o.destination);
  else { const v = await verify(o.archive, o.sha256, Number(o.bytes)); result = { status: v.status, archive_sha256: v.archive_sha256, archive_bytes: v.archive_bytes, root: v.manifest.root, total_bytes: v.manifest.total_bytes, entry_count: v.manifest.entries.length }; }
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(JSON.stringify({ status: 'blocked', code: e.code ?? 'IO_ERROR', message: e.message })); process.exitCode = 2; });
