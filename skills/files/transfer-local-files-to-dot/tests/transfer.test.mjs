import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pack, verify, extract } from '../scripts/transfer.mjs';

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dot-transfer-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'Example'); await fs.mkdir(source); await fs.mkdir(path.join(source, 'Nested'));
  await fs.mkdir(path.join(source, 'empty')); await fs.writeFile(path.join(source, 'hello.txt'), 'Hello, dot!\n');
  await fs.writeFile(path.join(source, 'Nested', '中文.txt'), '普通测试文件\n'); await fs.writeFile(path.join(source, 'zero.bin'), Buffer.alloc(0));
  return { dir, source };
}
function offsets(b) { const out = []; let p = 0; while (p + 512 <= b.length && b[p]) { const size = parseInt(b.toString('ascii', p + 124, p + 135), 8); out.push({ h: p, body: p + 512, size }); p += 512 + Math.ceil(size / 512) * 512; } return out; }
function recheck(b, h) { b.fill(32, h + 148, h + 156); const sum = b.subarray(h, h + 512).reduce((a, x) => a + x, 0); b.write(sum.toString(8).padStart(6, '0') + '\0 ', h + 148, 8); }
function field(b, h, at, len, str) { b.fill(0, h + at, h + at + len); b.write(str, h + at, len, 'utf8'); recheck(b, h); }
async function altered(t, change) { const f = await fixture(t); const r = await pack(f.source, path.join(f.dir, 'package')); const bytes = await fs.readFile(r.archive_path); const result = change(bytes, offsets(bytes)) ?? bytes; const archive = path.join(f.dir, 'altered.tar'); await fs.writeFile(archive, result); return { ...f, archive, bytes: result }; }
async function assertRejected(a, expected) { await assert.rejects(verify(a.archive, sha(a.bytes), a.bytes.length), e => e.code === expected, expected); }

test('round trip directory, Unicode, empty files/directories and deterministic bytes', async t => {
  const f = await fixture(t); const a = await pack(f.source, path.join(f.dir, 'p1')); const b = await pack(f.source, path.join(f.dir, 'p2'));
  assert.equal(a.archive_sha256, b.archive_sha256); assert.equal(a.file_count, 3);
  const v = await verify(a.archive_path, a.archive_sha256, a.archive_bytes); assert.equal(v.status, 'verified');
  const e = await extract(a.archive_path, a.archive_sha256, a.archive_bytes, path.join(f.dir, 'out'));
  assert.equal(e.status, 'materialized_and_verified'); assert.equal(await fs.readFile(path.join(e.consumer_local_root, 'Nested', '中文.txt'), 'utf8'), '普通测试文件\n');
  assert.equal((await fs.stat(path.join(e.consumer_local_root, 'empty'))).isDirectory(), true);
  assert.equal((await fs.stat(path.join(e.consumer_local_root, 'zero.bin'))).size, 0);
});
test('single ordinary file round trip', async t => { const f = await fixture(t); const a = await pack(path.join(f.source, 'hello.txt'), path.join(f.dir, 'package')); const e = await extract(a.archive_path, a.archive_sha256, a.archive_bytes, path.join(f.dir, 'out')); assert.equal(await fs.readFile(e.consumer_local_root, 'utf8'), 'Hello, dot!\n'); });
test('refuse existing output and extraction destinations without changing them', async t => { const f = await fixture(t); const p = path.join(f.dir, 'package'); const a = await pack(f.source, p); await assert.rejects(pack(f.source, p), e => e.code === 'DESTINATION_EXISTS'); await fs.mkdir(path.join(f.dir, 'out')); await fs.writeFile(path.join(f.dir, 'out', 'keep'), 'keep'); await assert.rejects(extract(a.archive_path, a.archive_sha256, a.archive_bytes, path.join(f.dir, 'out')), e => e.code === 'DESTINATION_EXISTS'); assert.equal(await fs.readFile(path.join(f.dir, 'out', 'keep'), 'utf8'), 'keep'); });
test('reject output inside source', async t => { const f = await fixture(t); await assert.rejects(pack(f.source, path.join(f.source, 'out')), e => e.code === 'INVALID_ARGUMENT'); });
test('reject relative source or output', async t => { const f = await fixture(t); await assert.rejects(pack('relative', path.join(f.dir, 'out')), e => e.code === 'INVALID_ARGUMENT'); await assert.rejects(pack(f.source, 'relative'), e => e.code === 'INVALID_ARGUMENT'); });
test('reject source root symlink', async t => { const f = await fixture(t); const link = path.join(f.dir, 'alias'); await fs.symlink(f.source, link); await assert.rejects(pack(link, path.join(f.dir, 'out')), e => e.code === 'SYMLINK_REJECTED'); });
test('reject nested symlink without dereferencing', async t => { const f = await fixture(t); await fs.symlink('/not-a-real-target', path.join(f.source, 'link')); await assert.rejects(pack(f.source, path.join(f.dir, 'out')), e => e.code === 'SYMLINK_REJECTED'); });
test('reject hardlinks', async t => { const f = await fixture(t); await fs.link(path.join(f.source, 'hello.txt'), path.join(f.source, 'hard')); await assert.rejects(pack(f.source, path.join(f.dir, 'out')), e => e.code === 'UNSAFE_FILE'); });
test('reject archive symlink', async t => { const f = await fixture(t); const a = await pack(f.source, path.join(f.dir, 'p')); const link = path.join(f.dir, 'link.tar'); await fs.symlink(a.archive_path, link); await assert.rejects(verify(link, a.archive_sha256, a.archive_bytes), e => e.code === 'UNSAFE_FILE'); });
for (const name of ['.env', '.env.local', '.git', '.ssh', '.aws', '.codex', 'credentials.json', 'private.pem']) test(`reject sensitive name ${name}`, async t => { const f = await fixture(t); await fs.writeFile(path.join(f.source, name), 'synthetic'); await assert.rejects(pack(f.source, path.join(f.dir, 'out')), e => e.code === 'SENSITIVE_PATH'); });
test('reject duplicate case-insensitive source paths', async t => { const f = await fixture(t); await fs.writeFile(path.join(f.source, 'HELLO.TXT'), 'collision'); const names = await fs.readdir(f.source); if (!(names.includes('hello.txt') && names.includes('HELLO.TXT'))) { t.skip('Filesystem cannot create case-distinct siblings; archive collision test remains active'); return; } await assert.rejects(pack(f.source, path.join(f.dir, 'out')), e => e.code === 'DUPLICATE_PATH'); });
test('reject nonportable filename', async t => { const f = await fixture(t); await fs.writeFile(path.join(f.source, 'CON.txt'), 'collision'); await assert.rejects(pack(f.source, path.join(f.dir, 'out')), e => e.code === 'UNSAFE_PATH'); });
test('reject oversized sparse source before reading it', async t => { const f = await fixture(t); const large = path.join(f.source, 'large.bin'); await fs.writeFile(large, ''); await fs.truncate(large, 100 * 1024 * 1024 + 1); await assert.rejects(pack(f.source, path.join(f.dir, 'out')), e => e.code === 'LIMIT_EXCEEDED'); });
test('reject excessive nesting', async t => { const f = await fixture(t); let p = f.source; for (let i = 0; i < 33; i++) { p = path.join(p, 'a'); await fs.mkdir(p); } await assert.rejects(pack(f.source, path.join(f.dir, 'out')), e => e.code === 'UNSAFE_PATH'); });
test('require trusted hash and byte count', async t => { const f = await fixture(t); const a = await pack(f.source, path.join(f.dir, 'p')); await assert.rejects(verify(a.archive_path, '0'.repeat(64), a.archive_bytes), e => e.code === 'INTEGRITY_MISMATCH'); await assert.rejects(verify(a.archive_path, a.archive_sha256, a.archive_bytes + 1), e => e.code === 'INTEGRITY_MISMATCH'); await assert.rejects(verify(a.archive_path, '', a.archive_bytes), e => e.code === 'INVALID_ARGUMENT'); });
for (const unsafe of ['../escape', '/absolute', 'C:/absolute', 'root/../escape', 'root\\escape']) test(`reject archive path ${unsafe}`, async t => { const a = await altered(t, (b, o) => field(b, o[1].h, 0, 100, unsafe)); await assertRejected(a, 'UNSAFE_PATH'); });
for (const type of ['1', '2', '3', '4', '6', 'x', 'g', 'L']) test(`reject archive type ${type}`, async t => { const a = await altered(t, (b, o) => field(b, o[1].h, 156, 1, type)); await assertRejected(a, 'UNSAFE_ARCHIVE_ENTRY'); });
test('reject link target field even on regular entry', async t => { const a = await altered(t, (b, o) => field(b, o[1].h, 157, 100, 'elsewhere')); await assertRejected(a, 'UNSAFE_ARCHIVE_ENTRY'); });
test('reject duplicate archive paths', async t => { const a = await altered(t, (b, o) => field(b, o[2].h, 0, 100, 'Example')); await assertRejected(a, 'DUPLICATE_PATH'); });
test('reject checksum corruption', async t => { const a = await altered(t, b => { b[0] ^= 1; }); await assertRejected(a, 'INVALID_ARCHIVE'); });
test('reject corrupted payload with original manifest', async t => { const a = await altered(t, (b, o) => { const file = o.find((x, i) => i > 0 && x.size > 0); b[file.body] ^= 1; }); await assertRejected(a, 'INTEGRITY_MISMATCH'); });
test('reject malformed manifest', async t => { const a = await altered(t, (b, o) => { b[o[0].body] = '!'.charCodeAt(0); }); await assertRejected(a, 'INVALID_MANIFEST'); });
test('reject unexpected manifest properties', async t => { const a = await altered(t, (b, o) => { const m = JSON.parse(b.toString('utf8', o[0].body, o[0].body + o[0].size)); m.extra = 'x'; const body = Buffer.from(JSON.stringify(m)); const oldBlocks = Math.ceil(o[0].size / 512); const newBlocks = Math.ceil(body.length / 512); assert.equal(newBlocks, oldBlocks); field(b, o[0].h, 124, 12, body.length.toString(8).padStart(11, '0') + '\0'); b.fill(0, o[0].body, o[0].body + oldBlocks * 512); body.copy(b, o[0].body); }); await assertRejected(a, 'INVALID_MANIFEST'); });
test('reject truncated archive', async t => { const a = await altered(t, b => b.subarray(0, b.length - 1)); await assertRejected(a, 'INVALID_ARCHIVE'); });
test('reject appended data', async t => { const a = await altered(t, b => Buffer.concat([b, Buffer.from('hidden')])); await assertRejected(a, 'INVALID_ARCHIVE'); });
test('reject corrupted padding', async t => { const a = await altered(t, (b, o) => { b[o[0].body + o[0].size] = 1; }); await assertRejected(a, 'INVALID_ARCHIVE'); });
test('reject oversized archive length before opening', async t => { const f = await fixture(t); await assert.rejects(verify(path.join(f.dir, 'none'), '0'.repeat(64), 216 * 1024 * 1024 + 1), e => e.code === 'INVALID_ARGUMENT'); });
test('USTAR prefix and non-ASCII names survive', async t => { const f = await fixture(t); const nested = path.join(f.source, 'a'.repeat(70)); await fs.mkdir(nested); await fs.writeFile(path.join(nested, 'b'.repeat(60)), 'long path'); const a = await pack(f.source, path.join(f.dir, 'p')); const e = await extract(a.archive_path, a.archive_sha256, a.archive_bytes, path.join(f.dir, 'out')); assert.equal(await fs.readFile(path.join(e.consumer_local_root, 'a'.repeat(70), 'b'.repeat(60)), 'utf8'), 'long path'); });
test('CLI reports structured errors and rejects unknown bypass flags', () => { const script = fileURLToPath(new URL('../scripts/transfer.mjs', import.meta.url)); const r = spawnSync(process.execPath, [script, 'pack', '--source', '/fake', '--output', '/fake', '--allow-secrets', 'true'], { encoding: 'utf8' }); assert.equal(r.status, 2); assert.equal(JSON.parse(r.stderr).code, 'INVALID_ARGUMENT'); });
test('CLI help has no transport claim', () => { const script = fileURLToPath(new URL('../scripts/transfer.mjs', import.meta.url)); const r = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' }); assert.equal(r.status, 0); assert.match(r.stdout, /No upload\/download capability/); });

test('reject source symlink with trailing slash', async t => { const f = await fixture(t); const link = path.join(f.dir, 'alias'); await fs.symlink(f.source, link); await assert.rejects(pack(link + '/', path.join(f.dir, 'out')), e => e.code === 'SYMLINK_REJECTED'); });
test('reject source under symlink ancestor', async t => { const f = await fixture(t); const link = path.join(f.dir, 'alias'); await fs.symlink(f.source, link); await assert.rejects(pack(path.join(link, 'hello.txt'), path.join(f.dir, 'out')), e => e.code === 'SYMLINK_REJECTED'); });
test('reject source traversal components', async t => { const f = await fixture(t); await assert.rejects(pack(f.source + '/Nested/../hello.txt', path.join(f.dir, 'out')), e => e.code === 'UNSAFE_PATH'); });

test('reject ordinary filename under sensitive ancestor', async t => { const f = await fixture(t); const parent = path.join(f.dir, '.ssh'); await fs.mkdir(parent); const file = path.join(parent, 'config'); await fs.writeFile(file, 'synthetic'); await assert.rejects(pack(file, path.join(f.dir, 'out')), e => e.code === 'SENSITIVE_PATH'); });
for (const name of ['.dot-transfer-manifest.json', '.DOT-TRANSFER-MANIFEST.JSON']) test(`reject reserved root ${name}`, async t => { const f = await fixture(t); const file = path.join(f.dir, name); await fs.writeFile(file, 'synthetic'); await assert.rejects(pack(file, path.join(f.dir, 'out')), e => e.code === 'UNSAFE_PATH'); });

test('reject high-bit type byte', async t => { const a = await altered(t, (b, o) => { b[o[1].h + 156] |= 128; recheck(b, o[1].h); }); await assertRejected(a, 'INVALID_ARCHIVE'); });
test('reject noncanonical ownership metadata', async t => { const a = await altered(t, (b, o) => field(b, o[1].h, 265, 32, 'untrusted')); await assertRejected(a, 'INVALID_ARCHIVE'); });
test('reject high-bit numeric fields', async t => { const a = await altered(t, (b, o) => { b[o[1].h + 124] |= 128; recheck(b, o[1].h); }); await assertRejected(a, 'INVALID_ARCHIVE'); });

test('reject case-insensitive duplicate archive paths on every filesystem', async t => { const a = await altered(t, (b, o) => field(b, o[2].h, 0, 100, 'EXAMPLE')); await assertRejected(a, 'DUPLICATE_PATH'); });

test('opaque synthetic payload is preserved byte-for-byte without scanning', async t => {
  const f = await fixture(t); const payload = Buffer.from('app_secret: SYNTHETIC-NOT-A-CREDENTIAL\nverification_token: SYNTHETIC-NOT-A-CREDENTIAL\ntext: 0001\n');
  const source = path.join(f.dir, 'ordinary-fixture.yml'); await fs.writeFile(source, payload);
  const a = await pack(source, path.join(f.dir, 'p')); const e = await extract(a.archive_path, a.archive_sha256, a.archive_bytes, path.join(f.dir, 'out'));
  assert.deepEqual(await fs.readFile(e.consumer_local_root), payload); assert.deepEqual(await fs.readFile(source), payload);
});
test('CLI output contains metadata only and never payload bodies', async t => {
  const f = await fixture(t); const marker = 'SYNTHETIC_PRIVATE_BODY_MUST_NOT_APPEAR'; const source = path.join(f.dir, 'ordinary.txt'); await fs.writeFile(source, marker);
  const script = fileURLToPath(new URL('../scripts/transfer.mjs', import.meta.url));
  const a = spawnSync(process.execPath, [script, 'pack', '--source', source, '--output', path.join(f.dir, 'p')], { encoding: 'utf8' }); assert.equal(a.status, 0); assert.equal((a.stdout + a.stderr).includes(marker), false);
  const receipt = JSON.parse(a.stdout); const b = spawnSync(process.execPath, [script, 'extract', '--archive', receipt.archive_path, '--sha256', receipt.archive_sha256, '--bytes', String(receipt.archive_bytes), '--destination', path.join(f.dir, 'out')], { encoding: 'utf8' });
  assert.equal(b.status, 0); assert.equal((b.stdout + b.stderr).includes(marker), false); assert.equal(await fs.readFile(JSON.parse(b.stdout).consumer_local_root, 'utf8'), marker); assert.equal(await fs.readFile(source, 'utf8'), marker);
});
