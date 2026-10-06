#!/usr/bin/env node
/** Same-process-session transport supervisor, not an agent or task executor. */
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let receiver, command, stopping = false;
// Only ChildProcess handles created here are signalled. Never read a PID file,
// kill an endpoint PID, remove a resident lock, or stop a reused receiver.
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
  // Use the server's existing health command from this same process session.
  const healthy = () => new Promise(resolve => {
    command = spawn(process.execPath, [settings.server, 'health', '--config', settings.config_ref, '--state-dir', settings.state_dir], {stdio:['ignore','pipe','pipe']});
    const probe = command; let output = '', size = 0;
    const timer = setTimeout(() => probe.kill('SIGTERM'), 15000);
    probe.stdout.on('data', chunk => { size += chunk.length; if (size < 1024*1024) output += chunk; else probe.kill('SIGTERM'); });
    probe.stderr.resume(); probe.on('error', () => resolve(false));
    probe.on('close', code => { clearTimeout(timer); command = undefined;
      try { const result = JSON.parse(output); resolve(code === 0 && result.ok === true && result.receiver_connected === true); }
      catch { resolve(false); }
    });
  });
  const endpoint = path.join(settings.state_dir, 'resident', 'endpoint.json');
  const reused = fs.existsSync(endpoint);
  if (!reused) {
    receiver = spawn(process.execPath, [settings.server, 'start', '--config', settings.config_ref, '--state-dir', settings.state_dir], {stdio:'ignore'});
    receiver.on('error', () => { stopping = true; });
  }
  const deadline = Date.now() + 30000;
  while (true) {
    try { if (!await healthy()) throw new Error(); break; }
    catch {
      if (reused || stopping || receiver?.exitCode !== null || receiver?.signalCode !== null || Date.now() >= deadline) throw new Error('health');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  emit({event:'ready', receiver:reused?'reused':'owned', reachable:true, connected:true,
    consumer:'awaiting-agent-command', platform_execution:false});
  const input = createInterface({input:process.stdin, crlfDelay:Infinity});
  for await (const line of input) {
    if (stopping) break;
    let request;
    try {
      if (Buffer.byteLength(line) > 65536) throw new Error();
      request = JSON.parse(line);
      if (!request || typeof request.id !== 'string' || request.id.length > 128 || !Array.isArray(request.args) ||
          !request.args.length || request.args.some(a => typeof a !== 'string' || a.includes('\0') || a === '--store' || a.startsWith('--store='))) throw new Error();
    } catch { emit({event:'invalid-command'}); continue; }
    // An agent explicitly supplies every CLI command. No shell evaluation, platform
    // API, natural-language routing, synthesized decisions or automatic re-arm.
    const result = await new Promise(resolve => {
      command = spawn(process.execPath, [fileURLToPath(new URL('./taskctl.mjs', import.meta.url)), '--store', store, ...request.args], {stdio:['ignore','pipe','pipe']});
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
} catch { emit({event:'blocked', reason:'managed-session-arguments-or-transport-unavailable'}); process.exitCode = 1; }
finally { stop(); }
