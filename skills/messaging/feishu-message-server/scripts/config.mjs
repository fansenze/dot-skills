import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_STATE = path.join(ROOT, '.local');
export const DEFAULT_CONFIG = path.join(DEFAULT_STATE, 'config.yml');
export const DOMAINS = Object.freeze({feishu: 'https://open.feishu.cn', lark: 'https://open.larksuite.com'});
export class SafeError extends Error {}
export class ConfigError extends SafeError {
  constructor(message, code = 'invalid_config') { super(message); this.code = code; }
}
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const REQUIRED_KEYS = ['app_id', 'app_secret'];
const CONFIG_KEYS = [...REQUIRED_KEYS, 'brand', 'bot_open_id'];
const aliases = name => [...new Set([name, name.toUpperCase(), name.replace(/_([a-z])/g, (_, c) => c.toUpperCase())])];

export function missingKeys(data) {
  return REQUIRED_KEYS.filter(name => !aliases(name).some(key => Object.hasOwn(data, key)
    && data[key] != null && !(typeof data[key] === 'string' && !data[key].trim())));
}

export function checkConfig(filename = DEFAULT_CONFIG) {
  try {
    const missing = missingKeys(readConfigDocument(filename).data);
    return missing.length ? {ok: false, missing} : {ok: true};
  } catch (error) {
    if (error.code === 'config_not_found') return {ok: false, missing: [...REQUIRED_KEYS]};
    return {ok: false, error: error instanceof ConfigError ? error.code : 'invalid_config'};
  }
}

export function fromMapping(data, brandOverride) {
  if (data !== object(data)) throw new ConfigError('Config must contain a top-level mapping');
  function value(name, fallback = '') {
    const values = aliases(name)
      .filter(k => Object.hasOwn(data, k)).map(k => data[k]);
    if (values.some(v => !isDeepStrictEqual(v, values[0]))) throw new ConfigError(`Conflicting aliases for ${name}`);
    return values.length ? values[0] : fallback;
  }
  function string(name, fallback = '') {
    const v = value(name, fallback);
    if (v == null) return '';
    if (typeof v !== 'string') throw new ConfigError(`Expected a string for ${name}`);
    return v.trim();
  }
  const app_id = string('app_id');
  const app_secret = string('app_secret');
  const missing = [['app_id', app_id], ['app_secret', app_secret]].filter(([,v]) => !v).map(([k]) => k);
  if (missing.length) throw new ConfigError(`Missing ${missing.join(', ')}; run feishu.sh init or provide --config`);
  const brand = brandOverride ?? string('brand', 'feishu');
  if (!Object.hasOwn(DOMAINS, brand)) throw new ConfigError('brand must be feishu or lark');
  const config = {app_id, brand, domain: DOMAINS[brand], bot_open_id: string('bot_open_id')};
  // Avoid accidental serialization of the secret. No environment credential discovery.
  Object.defineProperty(config, 'app_secret', {value: app_secret, enumerable: false});
  return config;
}

function readConfigDocument(filename) {
  let data, bytes;
  try {
    const fd = fs.openSync(filename, 'r');
    try {
      const buffer = Buffer.alloc(65537);
      const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (length > 65536) throw new ConfigError('Config file exceeds 64 KiB');
      bytes = buffer.subarray(0, length);
    } finally { fs.closeSync(fd); }
    data = parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes), {maxAliasCount: 0});
  } catch (error) {
    if (error instanceof SafeError) throw error;
    if (error.code === 'ENOENT') throw new ConfigError('Config file not found; run feishu.sh init or provide --config', 'config_not_found');
    if (['EACCES', 'EPERM'].includes(error.code)) throw new ConfigError('Config file is not readable', 'config_unreadable');
    throw new ConfigError('Invalid UTF-8 YAML config; values are hidden');
  }
  if (data == null) data = {};
  if (data !== object(data)) throw new ConfigError('Config must contain a top-level mapping');
  return {data, bytes};
}

export function loadConfig(filename = DEFAULT_CONFIG, brandOverride) {
  return fromMapping(readConfigDocument(filename).data, brandOverride);
}

export function prepareConfig({source, values, brand, tempRoot = os.tmpdir()} = {}) {
  const original = source ? readConfigDocument(source) : {data: {}};
  const data = {...original.data};
  if (values !== undefined) {
    if (values !== object(values)) throw new ConfigError('invalid_config');
    for (const name of CONFIG_KEYS) {
      const supplied = aliases(name).filter(key => Object.hasOwn(values, key));
      if (supplied.length) {
        for (const key of aliases(name)) delete data[key];
        for (const key of supplied) data[key] = values[key];
      }
    }
  }
  if (brand !== undefined) {
    for (const key of aliases('brand')) delete data[key];
    data.brand = brand;
  }
  const missing = missingKeys(data);
  if (missing.length) return {ok: false, missing};
  const copying = Boolean(source) && values === undefined && brand === undefined;
  const config = copying ? undefined : fromMapping(data);
  const directory = fs.mkdtempSync(path.join(tempRoot, 'feishu-message-server-'));
  try {
    fs.chmodSync(directory, 0o700);
    const suffix = copying && path.extname(source).toLowerCase() !== '.json' ? '.yml' : '.json';
    const filename = path.join(directory, 'config' + suffix);
    if (copying) {
      const fd = fs.openSync(filename, 'wx', 0o600);
      try { fs.writeFileSync(fd, original.bytes); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    } else initialize(filename, config.app_id, config.app_secret, config.brand, config.bot_open_id);
    return {ok: true, config: filename};
  } catch (error) {
    fs.rmSync(directory, {recursive: true, force: true});
    throw error;
  }
}

export function privateDirectory(directory) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  if (path.resolve(directory) === DEFAULT_STATE) fs.chmodSync(directory, 0o700);
}

export function initialize(filename, appId, appSecret, brand = 'feishu', botOpenId = '') {
  const config = fromMapping({app_id: appId, app_secret: appSecret, brand, bot_open_id: botOpenId});
  const data = {app_id: config.app_id, app_secret: config.app_secret};
  if (brand === 'lark') data.brand = 'lark';
  if (config.bot_open_id) data.bot_open_id = config.bot_open_id;
  privateDirectory(path.dirname(filename));
  let fd;
  try { fd = fs.openSync(filename, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new ConfigError('Config already exists; initialization never overwrites it');
    throw new ConfigError('Unable to create local config file');
  }
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return config;
}
