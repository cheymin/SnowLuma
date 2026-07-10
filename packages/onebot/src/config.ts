import { createLogger } from '@snowluma/common/logger';
import { isRealUin } from '@snowluma/common/uin';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import type {
  HttpClientNetwork,
  HttpServerNetwork,
  JsonObject,
  MessageFormat,
  OneBotConfig,
  OneBotNetworks,
  StatusCommandConfig,
  WsClientNetwork,
  WsRole,
  WsServerNetwork,
} from './types';

const log = createLogger('OneBot.Config');

const CONFIG_DIR = 'config';
const DEFAULT_CONFIG_PATH = path.join(CONFIG_DIR, 'onebot.json');
const DEFAULT_ACCESS_TOKEN_BYTES = 32;
const NODE_TIMER_MAX_MS = 2_147_483_647;
const PER_UIN_SNAPSHOT_MARKER = 'snapshot';

const DEFAULT_STATUS_COMMAND: StatusCommandConfig = {
  enabled: true,
  swallow: false,
  cooldownSeconds: 5,
  trigger: '#sl',
};
/** Upper bound on the status-command reply cooldown — a year is effectively "off but sane". */
const STATUS_COMMAND_COOLDOWN_MAX = 31_536_000;
/** Max length of a user-customised trigger word (UTF-16 code units). */
export const STATUS_COMMAND_TRIGGER_MAX_LENGTH = 32;

function makeDefaultStatusCommand(): StatusCommandConfig {
  return { ...DEFAULT_STATUS_COMMAND };
}

export function makeDefaultOneBotConfig(): OneBotConfig {
  return {
    networks: {
      httpServers: [{
        name: 'http-default',
        host: '0.0.0.0',
        port: 3000,
        path: '/',
        accessToken: generateAccessToken(),
        messageFormat: 'array',
        reportSelfMessage: false,
      }],
      httpClients: [],
      wsServers: [{
        name: 'ws-default',
        host: '0.0.0.0',
        port: 3001,
        path: '/',
        role: 'Universal',
        accessToken: generateAccessToken(),
        messageFormat: 'array',
        reportSelfMessage: false,
      }],
      wsClients: [],
    },
    statusCommand: makeDefaultStatusCommand(),
    notifications: { channelIds: [] },
  };
}

function generateAccessToken(): string {
  return randomBytes(DEFAULT_ACCESS_TOKEN_BYTES).toString('base64url');
}

export interface LoadOneBotConfigOptions {
  persistDefaults?: boolean;
}

/** A deterministic configuration error. Callers may safely return this as a
 *  4xx without conflating it with filesystem/runtime failures. */
export class OneBotConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OneBotConfigValidationError';
  }
}

export function loadOneBotConfig(uin: string, options: LoadOneBotConfigOptions = {}): OneBotConfig {
  ensureConfigDir();

  const perUinPath = path.join(CONFIG_DIR, `onebot_${uin}.json`);
  const globalRaw = tryLoadJson(DEFAULT_CONFIG_PATH);
  // A per-account desired config is authoritative state. Corruption must stop
  // startup instead of silently reviving global/default endpoints.
  const perUinRaw = tryLoadJson(perUinPath, true);
  const legacy = !!perUinRaw && hasLegacyTopLevel(perUinRaw);

  const sources: JsonObject[] = [];
  const isCanonicalSnapshot = perUinRaw?.mode === PER_UIN_SNAPSHOT_MARKER;
  if (globalRaw && !isCanonicalSnapshot) sources.push(globalRaw);
  if (perUinRaw) sources.push(perUinRaw);

  const config = fromJson(sources, !perUinRaw && !globalRaw);

  if (options.persistDefaults && (!perUinRaw || legacy)) {
    saveOneBotConfig(uin, config, { mode: globalRaw ? 'overlay' : 'snapshot' });
  }

  return config;
}

export interface SaveOneBotConfigOptions {
  /** Snapshot is the WebUI/user-save contract. Overlay is reserved for the
   *  automatic legacy/global-default materialization path. */
  mode?: 'snapshot' | 'overlay';
}

export function saveOneBotConfig(
  uin: string,
  config: OneBotConfig,
  options: SaveOneBotConfigOptions = {},
): void {
  assertValidOneBotConfig(config);
  ensureConfigDir();
  const perUinPath = path.join(CONFIG_DIR, `onebot_${uin}.json`);
  saveJson(perUinPath, toJsonObject(config, options.mode ?? 'snapshot'));
}

/** Validate the normalized, public OneBot configuration shape before it is
 *  persisted or compiled into a live network plan. Adapter names form one
 *  process-wide namespace per account, not four independent namespaces. */
export function assertValidOneBotConfig(value: unknown): asserts value is OneBotConfig {
  if (!isObject(value)) invalid('configuration must be an object');
  if (!isObject(value.networks)) invalid('networks must be an object');

  const seen = new Map<string, keyof OneBotNetworks>();
  const serverBindings = new Map<string, string>();
  validateNetworkList(value.networks, 'httpServers', seen, (item, at) => {
    validateServer(item, at);
    validateServerBinding(item, at, serverBindings);
  });
  validateNetworkList(value.networks, 'httpClients', seen, (item, at) => {
    validateClient(item, at, new Set(['http:', 'https:']));
    if (
      item.timeoutMs !== undefined &&
      (
        typeof item.timeoutMs !== 'number' ||
        !Number.isSafeInteger(item.timeoutMs) ||
        item.timeoutMs <= 0 ||
        item.timeoutMs > NODE_TIMER_MAX_MS
      )
    ) {
      invalid(`${at}.timeoutMs must be an integer between 1 and ${NODE_TIMER_MAX_MS}`);
    }
  });
  validateNetworkList(value.networks, 'wsServers', seen, (item, at) => {
    validateServer(item, at);
    validateServerBinding(item, at, serverBindings);
    validateRole(item.role, `${at}.role`);
  });
  validateNetworkList(value.networks, 'wsClients', seen, (item, at) => {
    validateClient(item, at, new Set(['ws:', 'wss:']));
    validateRole(item.role, `${at}.role`);
    if (
      item.reconnectIntervalMs !== undefined &&
      (
        typeof item.reconnectIntervalMs !== 'number' ||
        !Number.isSafeInteger(item.reconnectIntervalMs) ||
        item.reconnectIntervalMs < 1000 ||
        item.reconnectIntervalMs > NODE_TIMER_MAX_MS
      )
    ) {
      invalid(`${at}.reconnectIntervalMs must be an integer between 1000 and ${NODE_TIMER_MAX_MS}`);
    }
  });

  if (!isObject(value.statusCommand)) invalid('statusCommand must be an object');
  const status = value.statusCommand;
  if (typeof status.enabled !== 'boolean') invalid('statusCommand.enabled must be a boolean');
  if (typeof status.swallow !== 'boolean') invalid('statusCommand.swallow must be a boolean');
  if (
    typeof status.cooldownSeconds !== 'number' ||
    !Number.isInteger(status.cooldownSeconds) ||
    status.cooldownSeconds < 0
  ) {
    invalid('statusCommand.cooldownSeconds must be a non-negative integer');
  }
  if (
    typeof status.trigger !== 'string' ||
    !status.trigger.trim() ||
    status.trigger.length > STATUS_COMMAND_TRIGGER_MAX_LENGTH ||
    /[\r\n]/.test(status.trigger)
  ) {
    invalid(`statusCommand.trigger must be non-empty, single-line, and <= ${STATUS_COMMAND_TRIGGER_MAX_LENGTH} characters`);
  }

  if (value.notifications !== undefined) {
    if (!isObject(value.notifications) || !Array.isArray(value.notifications.channelIds)) {
      invalid('notifications.channelIds must be an array');
    }
    for (const [index, channelId] of value.notifications.channelIds.entries()) {
      if (typeof channelId !== 'string' || !channelId || channelId.length > 64 || !/^[\w.-]+$/.test(channelId)) {
        invalid(`notifications.channelIds[${index}] is invalid`);
      }
    }
  }
}

function validateNetworkList(
  networks: JsonObject,
  kind: keyof OneBotNetworks,
  seen: Map<string, keyof OneBotNetworks>,
  validateSpecific: (item: JsonObject, at: string) => void,
): void {
  const list = networks[kind];
  if (!Array.isArray(list)) invalid(`networks.${kind} must be an array`);
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    const at = `networks.${kind}[${index}]`;
    if (!isObject(item)) invalid(`${at} must be an object`);
    validateNetworkBase(item, at);
    const name = item.name as string;
    const previousKind = seen.get(name);
    if (previousKind !== undefined) {
      invalid(`network adapter name "${name}" is duplicated in ${previousKind} and ${kind}`);
    }
    seen.set(name, kind);
    validateSpecific(item, at);
  }
}

function validateNetworkBase(item: JsonObject, at: string): void {
  if (typeof item.name !== 'string' || !item.name.trim()) invalid(`${at}.name must be a non-empty string`);
  if (item.name !== (item.name as string).trim()) invalid(`${at}.name must not have surrounding whitespace`);
  if (item.enabled !== undefined && typeof item.enabled !== 'boolean') invalid(`${at}.enabled must be a boolean`);
  if (item.accessToken !== undefined && typeof item.accessToken !== 'string') {
    invalid(`${at}.accessToken must be a string`);
  }
  if (item.messageFormat !== 'array' && item.messageFormat !== 'string') {
    invalid(`${at}.messageFormat must be "array" or "string"`);
  }
  if (typeof item.reportSelfMessage !== 'boolean') invalid(`${at}.reportSelfMessage must be a boolean`);
}

function validateServer(item: JsonObject, at: string): void {
  if (!Number.isInteger(item.port) || (item.port as number) <= 0 || (item.port as number) > 65535) {
    invalid(`${at}.port must be an integer between 1 and 65535`);
  }
  if (item.host !== undefined) {
    if (typeof item.host !== 'string') invalid(`${at}.host must be a string`);
    if (!item.host.trim()) invalid(`${at}.host must be a non-empty string when provided`);
    if (item.host !== item.host.trim()) invalid(`${at}.host must not have surrounding whitespace`);
  }
  if (item.path !== undefined) {
    if (typeof item.path !== 'string') invalid(`${at}.path must be a string`);
    if (item.path !== item.path.trim()) invalid(`${at}.path must not have surrounding whitespace`);
    const pathValue = item.path || '/';
    if (!pathValue.startsWith('/')) invalid(`${at}.path must be empty or start with /`);
    if (pathValue.includes('?') || pathValue.includes('#')) invalid(`${at}.path must not include query or hash`);
    if (new URL(`http://127.0.0.1${pathValue}`).pathname !== pathValue) {
      invalid(`${at}.path must already be a normalized URL pathname`);
    }
  }
}

function validateServerBinding(item: JsonObject, at: string, bindings: Map<string, string>): void {
  if (item.enabled === false) return;
  const host = typeof item.host === 'string' && item.host.trim()
    ? item.host.trim().toLowerCase()
    : '0.0.0.0';
  const port = item.port as number;
  const binding = `${host}:${String(port)}`;
  const exact = bindings.get(binding);
  if (exact) invalid(`${at} conflicts with ${exact} on server binding ${binding}`);

  // A wildcard listener owns every address in its family. Conservatively
  // reject any second listener on the same port when either side is a
  // wildcard; otherwise the saved plan deterministically degrades at bind.
  const wildcardKey = `*:${String(port)}`;
  const previousWildcard = bindings.get(wildcardKey);
  if (previousWildcard) invalid(`${at} conflicts with ${previousWildcard} on wildcard server port ${String(port)}`);
  const isWildcard = host === '0.0.0.0' || host === '::' || host === '[::]';
  if (isWildcard) {
    const previousSamePort = [...bindings.entries()].find(([key]) => key.endsWith(`:${String(port)}`));
    if (previousSamePort) {
      invalid(`${at} conflicts with ${previousSamePort[1]} on wildcard server port ${String(port)}`);
    }
    bindings.set(wildcardKey, at);
  }
  bindings.set(binding, at);
}

function validateClient(item: JsonObject, at: string, protocols: ReadonlySet<string>): void {
  if (typeof item.url !== 'string') invalid(`${at}.url must be a string`);
  if (item.enabled === false) return;
  if (!item.url.trim()) invalid(`${at}.url must be non-empty while the adapter is enabled`);
  let parsed: URL;
  try {
    parsed = new URL(item.url);
  } catch {
    invalid(`${at}.url must be a valid absolute URL`);
  }
  if (!protocols.has(parsed.protocol)) {
    invalid(`${at}.url protocol must be one of ${[...protocols].join(', ')}`);
  }
}

function validateRole(value: unknown, at: string): void {
  if (value !== undefined && value !== 'Api' && value !== 'Event' && value !== 'Universal') {
    invalid(`${at} must be Api, Event, or Universal`);
  }
}

function invalid(message: string): never {
  throw new OneBotConfigValidationError(message);
}

function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

const PER_UIN_CONFIG = /^onebot_(\d+)\.json$/;

/**
 * Remove per-UIN config files whose UIN is not a real QQ account — leftovers
 * from the phantom-account bug where the native hook reported a garbage
 * (timestamp-shaped) UIN and a `onebot_<garbage>.json` got persisted (issue
 * #162). Only files matching `onebot_<digits>.json` are considered, and only
 * those failing isRealUin (i.e. 11+ digits) are deleted — legitimate accounts
 * are never touched. Returns the deleted file names. Safe to call at startup.
 */
export function cleanupInvalidPerUinConfigs(): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(CONFIG_DIR);
  } catch {
    return []; // config dir not created yet — nothing to clean
  }
  const removed: string[] = [];
  for (const name of entries) {
    const match = PER_UIN_CONFIG.exec(name);
    if (!match || isRealUin(match[1])) continue;
    try {
      fs.unlinkSync(path.join(CONFIG_DIR, name));
      removed.push(name);
      log.warn('removed phantom per-UIN config (invalid UIN): %s', name);
    } catch (err) {
      log.warn('failed to remove phantom config %s: %s', name, err instanceof Error ? err.message : String(err));
    }
  }
  return removed;
}

function toJsonObject(config: OneBotConfig, mode: 'snapshot' | 'overlay'): JsonObject {
  const nets = config.networks;
  return {
    // Canonical per-UIN files are complete desired-state snapshots. Older
    // files without this marker retain the legacy global-overlay migration
    // behavior until their next successful save.
    mode,
    networks: {
      httpServers: nets.httpServers.map(httpServerToJson),
      httpClients: nets.httpClients.map(httpClientToJson),
      wsServers: nets.wsServers.map(wsServerToJson),
      wsClients: nets.wsClients.map(wsClientToJson),
    },
    statusCommand: {
      enabled: config.statusCommand.enabled,
      swallow: config.statusCommand.swallow,
      cooldownSeconds: config.statusCommand.cooldownSeconds,
      trigger: config.statusCommand.trigger,
    },
    notifications: { channelIds: config.notifications?.channelIds ?? [] },
  };
}

function applyBase(
  out: JsonObject,
  n: { name: string; enabled?: boolean; accessToken?: string; messageFormat: MessageFormat; reportSelfMessage: boolean },
): void {
  out.name = n.name;
  if (n.enabled === false) out.enabled = false;
  if (n.accessToken) out.accessToken = n.accessToken;
  out.messageFormat = n.messageFormat;
  out.reportSelfMessage = n.reportSelfMessage;
}

function httpServerToJson(n: HttpServerNetwork): JsonObject {
  const out: JsonObject = {};
  applyBase(out, n);
  out.host = n.host ?? '0.0.0.0';
  out.port = n.port;
  out.path = n.path ?? '/';
  return out;
}

function httpClientToJson(n: HttpClientNetwork): JsonObject {
  const out: JsonObject = {};
  applyBase(out, n);
  out.url = n.url;
  if (typeof n.timeoutMs === 'number' && n.timeoutMs > 0) out.timeoutMs = n.timeoutMs;
  return out;
}

function wsServerToJson(n: WsServerNetwork): JsonObject {
  const out: JsonObject = {};
  applyBase(out, n);
  out.host = n.host ?? '0.0.0.0';
  out.port = n.port;
  out.path = n.path ?? '/';
  out.role = n.role ?? 'Universal';
  return out;
}

function wsClientToJson(n: WsClientNetwork): JsonObject {
  const out: JsonObject = {};
  applyBase(out, n);
  out.url = n.url;
  out.role = n.role ?? 'Universal';
  out.reconnectIntervalMs =
    typeof n.reconnectIntervalMs === 'number' && Number.isFinite(n.reconnectIntervalMs)
      ? Math.max(1000, Math.trunc(n.reconnectIntervalMs))
      : 5000;
  return out;
}

function fromJson(sources: JsonObject[], freshInstall: boolean): OneBotConfig {
  let legacyFormat: MessageFormat | undefined;
  let legacyReport: boolean | undefined;
  for (const src of sources) {
    const mf = parseMessageFormat(src.messageFormat);
    if (mf) legacyFormat = mf;
    if (typeof src.reportSelfMessage === 'boolean') legacyReport = src.reportSelfMessage;
  }
  const inheritedFormat: MessageFormat = legacyFormat ?? 'array';
  const inheritedReport: boolean = legacyReport ?? false;
  const adapterDefaults = { messageFormat: inheritedFormat, reportSelfMessage: inheritedReport };
  const httpServers = collectByName<HttpServerNetwork>(sources, 'httpServers', (raw) => parseHttpServer(raw, adapterDefaults));
  const httpClients = collectByName<HttpClientNetwork>(sources, 'httpClients', (raw) => parseHttpClient(raw, adapterDefaults), 'httpPostEndpoints');
  const wsServers = collectByName<WsServerNetwork>(sources, 'wsServers', (raw) => parseWsServer(raw, adapterDefaults));
  const wsClients = collectByName<WsClientNetwork>(sources, 'wsClients', (raw) => parseWsClient(raw, adapterDefaults));
  if (
    freshInstall &&
    httpServers.length === 0 &&
    httpClients.length === 0 &&
    wsServers.length === 0 &&
    wsClients.length === 0
  ) {
    const defaults = makeDefaultOneBotConfig().networks;
    httpServers.push(...defaults.httpServers);
    wsServers.push(...defaults.wsServers);
  }

  const networks: OneBotNetworks = { httpServers, httpClients, wsServers, wsClients };
  const config: OneBotConfig = {
    networks,
    statusCommand: parseStatusCommand(sources),
    notifications: parseNotifications(sources),
  };
  assertValidOneBotConfig(config);
  return config;
}

/** Last-write-wins merge of `notifications.channelIds` across config sources,
 *  each id validated as a slug + deduped. Mirrors the channel-id rule in
 *  packages/core/src/notifications/config.ts (CHANNEL_ID_RE) — duplicated
 *  deliberately: core depends on onebot, so onebot cannot import from core. */
function parseNotifications(sources: JsonObject[]): { channelIds: string[] } {
  let channelIds: string[] = [];
  for (const src of sources) {
    const raw = src.notifications;
    if (!isObject(raw)) continue;
    if (Array.isArray(raw.channelIds)) channelIds = normalizeChannelIds(raw.channelIds);
  }
  return { channelIds };
}

function normalizeChannelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const v = item.trim();
    if (!v || v.length > 64 || !/^[\w.-]+$/.test(v)) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Last-write-wins merge of `statusCommand` across config sources, with
 *  defaults filled and the cooldown clamped to a sane non-negative range. */
function parseStatusCommand(sources: JsonObject[]): StatusCommandConfig {
  const out = makeDefaultStatusCommand();
  for (const src of sources) {
    const raw = src.statusCommand;
    if (!isObject(raw)) continue;
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
    if (typeof raw.swallow === 'boolean') out.swallow = raw.swallow;
    if (raw.cooldownSeconds !== undefined) {
      out.cooldownSeconds = Math.min(
        STATUS_COMMAND_COOLDOWN_MAX,
        asNumber(raw.cooldownSeconds, DEFAULT_STATUS_COMMAND.cooldownSeconds),
      );
    }
    if (typeof raw.trigger === 'string' && raw.trigger.trim().length > 0 && !/[\r\n]/.test(raw.trigger)) {
      out.trigger = raw.trigger.trim().slice(0, STATUS_COMMAND_TRIGGER_MAX_LENGTH);
    }
  }
  return out;
}

function collectByName<T extends { name: string }>(
  sources: JsonObject[],
  kind: keyof OneBotNetworks,
  parse: (raw: JsonObject) => T | null,
  legacyKey?: string,
): T[] {
  const byName = new Map<string, T>();
  const order: string[] = [];

  let counter = 0;
  const ingest = (rawArr: unknown): void => {
    if (!Array.isArray(rawArr)) return;
    for (const raw of rawArr) {
      if (!isObject(raw)) continue;
      const parsed = parse(raw);
      if (!parsed) continue;
      const name = parsed.name && parsed.name.trim() ? parsed.name.trim() : pickAutoName(kind, byName, ++counter);
      parsed.name = name;
      if (!byName.has(name)) order.push(name);
      byName.set(name, parsed);
    }
  };

  for (const src of sources) {
    const nested = isObject(src.networks) ? (src.networks as JsonObject)[kind] : undefined;
    ingest(nested);
    if (legacyKey) ingest(src[legacyKey]);
    ingest(src[kind]);
  }

  return order.map((n) => byName.get(n)!);
}

function pickAutoName(kind: keyof OneBotNetworks, used: Map<string, unknown>, counter: number): string {
  const prefix =
    kind === 'httpServers' ? 'http' :
      kind === 'httpClients' ? 'httppost' :
        kind === 'wsServers' ? 'ws' :
          'wsclient';
  let candidate = `${prefix}-${counter}`;
  while (used.has(candidate)) {
    counter += 1;
    candidate = `${prefix}-${counter}`;
  }
  return candidate;
}

interface AdapterDefaults {
  messageFormat: MessageFormat;
  reportSelfMessage: boolean;
}

function parseBase(value: JsonObject, defaults: AdapterDefaults) {
  return {
    name: asString(value.name),
    enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
    accessToken: asString(value.accessToken) || undefined,
    messageFormat: parseMessageFormat(value.messageFormat) ?? defaults.messageFormat,
    reportSelfMessage:
      typeof value.reportSelfMessage === 'boolean' ? value.reportSelfMessage : defaults.reportSelfMessage,
  };
}

function parseHttpServer(value: JsonObject, defaults: AdapterDefaults): HttpServerNetwork | null {
  const port = asNumber(value.port, 0);
  if (port <= 0) return null;
  return clean({
    ...parseBase(value, defaults),
    host: asString(value.host, '0.0.0.0'),
    port,
    path: asString(value.path, '/'),
  });
}

function parseHttpClient(value: JsonObject, defaults: AdapterDefaults): HttpClientNetwork | null {
  const url = asString(value.url);
  const base = parseBase(value, defaults);
  if (!url && base.enabled !== false) return null;
  const timeout = asNumber(value.timeoutMs, 0);
  return clean({
    ...base,
    url,
    timeoutMs: timeout > 0 ? timeout : undefined,
  });
}

function parseWsServer(value: JsonObject, defaults: AdapterDefaults): WsServerNetwork | null {
  const port = asNumber(value.port, 0);
  if (port <= 0) return null;
  return clean({
    ...parseBase(value, defaults),
    host: asString(value.host, '0.0.0.0'),
    port,
    path: asString(value.path, '/'),
    role: asRole(value.role, 'Universal'),
  });
}

function parseWsClient(value: JsonObject, defaults: AdapterDefaults): WsClientNetwork | null {
  const url = asString(value.url);
  const base = parseBase(value, defaults);
  if (!url && base.enabled !== false) return null;
  const reconnectIntervalMs = asNumber(value.reconnectIntervalMs, 5000);
  return clean({
    ...base,
    url,
    role: asRole(value.role, 'Universal'),
    reconnectIntervalMs: Math.max(1000, reconnectIntervalMs),
  });
}

function hasLegacyTopLevel(raw: JsonObject): boolean {
  return (
    Array.isArray(raw.httpServers) ||
    Array.isArray(raw.httpPostEndpoints) ||
    Array.isArray(raw.wsServers) ||
    Array.isArray(raw.wsClients) ||
    typeof raw.messageFormat === 'string' ||
    typeof raw.reportSelfMessage === 'boolean'
  );
}

function parseMessageFormat(value: unknown): MessageFormat | undefined {
  if (value === 'array' || value === 'string') return value;
  return undefined;
}

function clean<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

function asRole(value: unknown, fallback: WsRole): WsRole {
  const text = asString(value, fallback).toLowerCase();
  if (text === 'api') return 'Api';
  if (text === 'event') return 'Event';
  if (text === 'universal') return 'Universal';
  return fallback;
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(0, Math.trunc(n));
  }
  return fallback;
}

function tryLoadJson(filePath: string, failOnCorrupt = false): JsonObject | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) throw new Error('configuration root must be an object');
    return parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (failOnCorrupt) {
      throw new Error(`config file ${filePath} is corrupt: ${message}`, { cause: err });
    }
    log.warn('config file %s is corrupt and will be ignored: %s', filePath, message);
    return null;
  }
}

function saveJson(filePath: string, json: JsonObject): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(json, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* preserve the primary write error */ }
    }
    try { fs.unlinkSync(tempPath); } catch { /* temp may not exist or rename succeeded */ }
    throw error;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
