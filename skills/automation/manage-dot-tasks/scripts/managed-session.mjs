#!/usr/bin/env node
/** Same-process-session transport supervisor, not an agent or task executor. */
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let receiver, command, ownerFd, stopping = false;
const closed = new Map();
function track(child) {
  closed.set(child, new Promise(resolve => { child.once('close', code => { closed.delete(child); resolve(code); }); }));
  return child;
}
function privatePath(filename, directory = false) {
  const st = fs.lstatSync(filename);
  if ((directory ? !st.isDirectory() : !st.isFile()) || st.isSymbolicLink() ||
      (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid())) throw new Error('managed-session-unsafe-state');
}
function ownNewState(stateDir) {
  fs.mkdirSync(stateDir, {recursive:true, mode:0o700}); privatePath(stateDir,true);
  const resident = path.join(stateDir,'resident'), stable = path.join(stateDir,'managed-session.flock');
  // This workflow enrolls a fresh, dedicated state only. It never adopts a
  // separately started receiver or an existing state without this stable lock.
  if (!fs.existsSync(stable) && [path.join(resident,'endpoint.json'),path.join(resident,'resident.lock'),path.join(stateDir,'node-listener.lock')].some(p=>fs.existsSync(p))) throw new Error('managed-session-requires-new-state');
  ownerFd = fs.openSync(stable, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  privatePath(stable);
  const held = spawnSync('/usr/bin/flock',['-n','-E','75','3'],{stdio:['ignore','ignore','ignore',ownerFd]});
  if (held.status !== 0) throw new Error('managed-session-owner-held-or-lock-unavailable');
  // Every participating parent and receiver holds this same open description.
  // Acquiring it proves those prior processes are gone, not merely timed out.
  const endpoint = path.join(resident,'endpoint.json');
  const locks = [path.join(resident,'resident.lock'),path.join(stateDir,'node-listener.lock')];
  if (fs.existsSync(resident)) privatePath(resident,true);
  if (fs.existsSync(endpoint)) privatePath(endpoint);
  for (const lock of locks.filter(p=>fs.existsSync(p))) {
    privatePath(lock,true);
    const names=fs.readdirSync(lock);
    if (names.length !== 1 || names[0] !== 'pid') throw new Error('managed-session-unexpected-lock-shape');
    privatePath(path.join(lock,'pid'));
  }
  // Validate all shapes before changing any. Keep receipts, inbox and task state.
  if (fs.existsSync(endpoint)) fs.unlinkSync(endpoint);
  for (const lock of locks.filter(p=>fs.existsSync(p))) {fs.unlinkSync(path.join(lock,'pid'));fs.rmdirSync(lock);}
}
// Stop signals target only ChildProcess handles created by this supervisor.
// PID files are never used to signal processes.
function stop() {
  stopping = true;
  process.stdin.destroy();
  for (const child of [command, receiver]) if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  const {values} = parseArgs({options: {store: {type:'string'}, 'settings-file': {type:'string'}}, strict:true});
  if (!values.store || !values['settings-file']) throw new Error('arguments');
  const store = path.resolve(values.store), settings = JSON.parse(fs.readFileSync(values['settings-file'], 'utf8'));
  ownNewState(settings.state_dir);
  // Use the server's existing health command from this same process session.
  const healthy = () => new Promise(resolve => {
    command = track(spawn(process.execPath, [settings.server, 'health', '--config', settings.config_ref, '--state-dir', settings.state_dir], {stdio:['ignore','pipe','pipe']}));
    const probe = command; let output = '', size = 0;
    const timer = setTimeout(() => probe.kill('SIGTERM'), 15000);
    probe.stdout.on('data', chunk => { size += chunk.length; if (size < 1024*1024) output += chunk; else probe.kill('SIGTERM'); });
    probe.stderr.resume(); probe.on('error', () => resolve(false));
    probe.on('close', code => { clearTimeout(timer); command = undefined;
      try { const result = JSON.parse(output); resolve(code === 0 && result.ok === true && result.receiver_connected === true); }
      catch { resolve(false); }
    });
  });
  // FD 3 is inherited by the actual receiver. If this supervisor is killed,
  // its surviving receiver continues to exclude any replacement supervisor.
  receiver = track(spawn(process.execPath, [settings.server, 'start', '--config', settings.config_ref, '--state-dir', settings.state_dir], {stdio:['ignore','ignore','ignore',ownerFd]}));
  receiver.on('error', () => { stopping = true; });
  const deadline = Date.now() + 30000;
  while (true) {
    try { if (!await healthy()) throw new Error(); break; }
    catch {
      if (stopping || receiver?.exitCode !== null || receiver?.signalCode !== null || Date.now() >= deadline) throw new Error('health');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  emit({event:'ready', receiver:'owned', reachable:true, connected:true,
    consumer:'awaiting-agent-command', platform_execution:false});
  const input = createInterface({input:process.stdin, crlfDelay:Infinity});
  for await (const line of input) {
    if (stopping) break;
    let request;
    try {
      if (Buffer.byteLength(line) > 65536) throw new Error();
      request = JSON.parse(line);
      if (request?.operation === 'check' && typeof request.id === 'string' && request.id.length <= 128 && !request.args) {
        emit({event:'result',id:request.id,operation:'check',ok:await healthy(),receiver:'owned'}); continue;
      }
      if (!request || typeof request.id !== 'string' || request.id.length > 128 || !Array.isArray(request.args) ||
          !request.args.length || request.args.some(a => typeof a !== 'string' || a.includes('\0') || a === '--store' || a.startsWith('--store='))) throw new Error();
    } catch { emit({event:'invalid-command'}); continue; }
    // An agent explicitly supplies every CLI command. No shell evaluation, platform
    // API, natural-language routing, synthesized decisions or automatic re-arm.
    const result = await new Promise(resolve => {
      command = track(spawn(process.execPath, [fileURLToPath(new URL('./taskctl.mjs', import.meta.url)), '--store', store, ...request.args], {stdio:['ignore','pipe','pipe']}));
      let output = '', size = 0;
      command.stdout.on('data', chunk => { size += chunk.length; if (size <= 4*1024*1024) output += chunk; else command.kill('SIGTERM'); });
      command.stderr.resume();
      command.on('error', () => resolve({ok:false, error:'command-unavailable'}));
      command.on('close', code => {
        try { resolve({ok:code === 0, result:JSON.parse(output)}); }
        catch { resolve({ok:false,error:'command-result-unavailable'}); }
      });
    });
    emit({event:'result', id:request.id, ...result}); command = undefined;
  }
} catch (error) { if (!stopping) { emit({event:'blocked', reason: /^managed-session-[a-z-]+$/.test(error.message) ? error.message : 'managed-session-arguments-or-transport-unavailable'}); process.exitCode = 1; } }
finally { stop(); await Promise.allSettled([...closed.values()]); if (ownerFd !== undefined) fs.closeSync(ownerFd); }
