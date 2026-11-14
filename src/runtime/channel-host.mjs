import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createChannelCommonTools } from '../core/channel-common-tools.mjs';
import { startChannelToolServer } from '../core/channel-tool-server.mjs';
import { createHostedChannelTurnRunner } from '../core/channel-turn-host.mjs';
import { decodeIdentityKey, readAccountRef, sameAccount } from '../core/identity.mjs';
import { openChannelInbox } from '../core/inbox-store.mjs';
import { openChannelOutbox } from '../core/outbox-store.mjs';
import { sensitiveTextForms, SENSITIVE_RE } from '../sensitive.js';
import { hardenDir, isHardened } from '../state-acl.mjs';

const MAX_TURNS = 4;
const MAX_QUEUE = 1000;
const DISABLED = Object.freeze({ status: 'retryableFailure', reason: 'channel_unavailable' });
const STALE_POLL = Object.freeze({ status: 'retryableFailure', reason: 'stale_checkpoint' });
const TRANSPORT_CONFIG = {
  feishu: { transport: 'websocket', credentials: ['appSecretEnv'] },
  telegram: { transport: 'polling', credentials: ['botTokenEnv', 'proxyUrlEnv'] },
};

function entryStat(file) {
  try { return lstatSync(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function verifyFile(file) {
  const stat = entryStat(file);
  if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error('Unsafe channel state file');
}

function verifyTree(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, item.name);
    if (item.isDirectory()) verifyTree(file);
    else if (item.isFile()) verifyFile(file);
    else throw new Error('Unsafe entry in channel state directory');
  }
}

function prepareState(stateDir, workspacePath) {
  if (!lstatSync(dirname(stateDir)).isDirectory()) throw new Error('Unsafe channel state parent directory');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (!lstatSync(stateDir).isDirectory()) throw new Error('Unsafe channel state directory');
  for (const db of ['inbox.sqlite', 'outbox.sqlite']) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) verifyFile(join(stateDir, db + suffix));
  }
  if (!isHardened(stateDir)) {
    if (process.platform === 'win32') verifyTree(stateDir);
    if (!hardenDir(stateDir).ok) throw new Error('Unable to protect channel state directory');
  }
  if (dirname(workspacePath) === stateDir) {
    if (!entryStat(workspacePath)) mkdirSync(workspacePath, { mode: 0o700 });
  }
  if (!entryStat(workspacePath)?.isDirectory()) throw new Error('Unsafe channel workspace directory');
}

function readSync(callback, ...args) {
  const value = callback(...args);
  if (typeof value?.then === 'function') {
    void Promise.resolve(value).catch(() => {});
    throw new TypeError('Channel host callback must be synchronous');
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describeTransport(platform, settings) {
  const { transport, credentials } = TRANSPORT_CONFIG[platform];
  if (settings.transport !== undefined && settings.transport !== transport) return null;
  if (platform === 'feishu' && settings.domain !== undefined && settings.domain !== 'feishu') return null;
  const identity = [];
  for (const field of credentials) {
    const name = settings[field];
    if (name === undefined) {
      identity.push(null);
      continue;
    }
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
    const value = process.env[name];
    if (!value && field !== 'proxyUrlEnv') return null;
    identity.push([name, value ? createHash('sha256').update(value).digest('hex') : null]);
  }
  return [settings.appId ?? null, settings.accountId ?? null, settings.tenantId ?? null, identity];
}

/** Compose the trusted bridge, durable queues and verified platform registrations. */
export async function startChannelHost({
  api, workspacePath, stateDir, longMemory, rag, readConfig, readRoleState, readRoleCard, isSensitive,
  canRunTurns = () => true, enableTextTools = false, log = () => {}, intervalMs = 500,
} = {}) {
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir) ||
      typeof workspacePath !== 'string' || !isAbsolute(workspacePath) ||
      !longMemory?.channelArchive || ![readConfig, canRunTurns, log].every((fn) => typeof fn === 'function') ||
      typeof enableTextTools !== 'boolean' || (enableTextTools && typeof isSensitive !== 'function') ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60_000) {
    throw new TypeError('Invalid channel host configuration');
  }
  stateDir = resolve(stateDir);
  workspacePath = resolve(workspacePath);
  prepareState(stateDir, workspacePath);

  const outboxFile = join(stateDir, 'outbox.sqlite');
  let outbox;
  let inbox;
  try {
    if (enableTextTools || entryStat(outboxFile)) outbox = openChannelOutbox(outboxFile);
    inbox = openChannelInbox(join(stateDir, 'inbox.sqlite'), { archive: longMemory.channelArchive, outbox });
  } catch (error) {
    outbox?.close();
    throw error;
  }
  const bindings = inbox.privateBindings;
  const accounts = new Map();
  const recoveryAccounts = new Map();
  const activeTurns = new Map();
  const activeSends = new Map();
  const projectionFailures = new Set();
  let hosted;
  let textHosted;
  let toolServer;
  let timer;
  let closing;
  let stopped = false;
  let textToolsAllowed = false;
  let roleSilent = false;
  let accountCursor = 0;

  function report(message) {
    try { log(`[channels] ${message}`); } catch { /* Diagnostics cannot interrupt lifecycle. */ }
  }

  function clearScopes(entry) {
    for (const key of entry.scopes.keys()) clearScope(entry, key);
  }

  function invalidateAll() {
    for (const entry of accounts.values()) clearScopes(entry);
  }

  function readChannels() {
    try { return readSync(readConfig)?.channels; } catch { return null; }
  }

  function refreshEntry(entry, settings) {
    const { account } = entry;
    let policy = null;
    try {
      if (isRecord(settings) && typeof settings.enabled === 'boolean') {
        const transport = describeTransport(account.platform, settings);
        if (transport && entry.transport && !isDeepStrictEqual(entry.transport, transport)) entry.replaced = true;
        if (transport && !entry.transport) entry.transport = transport;
        const current = !entry.replaced && transport !== null &&
          (settings.appId === undefined || settings.appId === account.accountId) &&
          (settings.accountId === undefined || settings.accountId === account.accountId) &&
          (settings.tenantId === undefined || settings.tenantId === account.tenantId) &&
          readSync(entry.isCurrent) === true;
        if (settings.enabled === false) policy = { ...account, enabled: false };
        else if (current) {
          policy = structuredClone({
            ...account, enabled: true, allow: settings.allow, deny: settings.deny, admins: settings.admins,
            groupPolicy: settings.groupPolicy, observationVerified: entry.observationVerified,
          });
        }
      }
    } catch { /* Malformed or unavailable settings provide no authorization. */ }

    const active = policy?.enabled === true;
    if (entry.active !== active) entry.pollEpoch++;
    if (!isDeepStrictEqual(entry.policy, policy)) clearScopes(entry);
    entry.active = active;
    entry.policy = policy;
  }

  function reload() {
    if (stopped) return;
    const channels = readChannels();
    const textEnabled = enableTextTools && channels?.textTools === true;
    let silent = false;
    try { silent = readRoleState !== undefined && readSync(readRoleState)?.mode === 'silent'; }
    catch { silent = true; }
    if (textEnabled !== textToolsAllowed || silent !== roleSilent) invalidateAll();
    textToolsAllowed = textEnabled;
    roleSilent = silent;

    for (const entry of accounts.values()) refreshEntry(entry, channels?.[entry.account.platform]);
  }

  function entryFor(account) {
    const entry = accounts.get(account.platform);
    return entry && sameAccount(entry.account, account) ? entry : null;
  }

  function readPolicy(entry) {
    reload();
    return !stopped && entryFor(entry.account) === entry ? entry.policy : null;
  }

  function isScopeCurrent({ conversationKey }, requiresTextTools) {
    if (stopped) return false;
    const conversation = decodeIdentityKey(conversationKey);
    const entry = entryFor(conversation);
    if (!entry || readPolicy(entry)?.enabled !== true || requiresTextTools !== textToolsAllowed) return false;
    const revision = conversation.chatType === 'private' && conversation.threadId === null
      ? bindings.revisionForConversation(conversationKey) : null;
    if (entry.scopes.has(conversationKey) && entry.scopes.get(conversationKey) !== revision) {
      clearScope(entry, conversationKey);
      return false;
    }
    // Use insertion order to cap cached generations for accounts that see many
    // conversations over their lifetime. Eviction revokes the corresponding grant.
    entry.scopes.delete(conversationKey);
    entry.scopes.set(conversationKey, revision);
    if (entry.scopes.size > MAX_QUEUE) clearScope(entry, entry.scopes.keys().next().value);
    return true;
  }

  function clearScope(entry, conversationKey) {
    entry.scopes.delete(conversationKey);
    hosted?.invalidateSource(conversationKey);
    textHosted?.invalidateSource(conversationKey);
  }

  function mutateBinding(work) {
    if (stopped) throw new Error('Channel host is closed');
    const result = work();
    for (const entry of accounts.values()) {
      for (const [key, revision] of entry.scopes) {
        const conversation = decodeIdentityKey(key);
        if (conversation.chatType === 'private' && conversation.threadId === null &&
            bindings.revisionForConversation(key) !== revision) clearScope(entry, key);
      }
    }
    return result;
  }

  const privateBindings = {
    resolve(endpoint) {
      if (stopped) throw new Error('Channel host is closed');
      return bindings.resolve(endpoint);
    },
    link: (endpoints) => mutateBinding(() => bindings.link(endpoints)),
    unlink: (endpoint) => mutateBinding(() => bindings.unlink(endpoint)),
  };

  function authorizeCommonSource({ source }) {
    const entry = entryFor(source.conversation);
    const policy = entry && readPolicy(entry);
    return textToolsAllowed && !roleSilent ? policy : null;
  }

  function authorizeSource({ source }) {
    const entry = entryFor(source.conversation);
    const policy = entry && readPolicy(entry);
    return textToolsAllowed && typeof entry?.adapter?.sendText === 'function' ? policy : null;
  }

  function adapterFor(account) {
    const entry = entryFor(account);
    return entry && readPolicy(entry)?.enabled === true && textToolsAllowed ? entry.adapter : null;
  }

  function containsSensitive(text) {
    if (readSync(isSensitive, text) !== false) return true;
    if (toolServer && sensitiveTextForms(text).some((form) => form.toLowerCase().includes(toolServer.secret))) return true;
    // All channels share the bridge. A platform's known secrets must be
    // protected even if the tool tries to send them through a different one.
    for (const entry of accounts.values()) {
      if (entry.isSensitive && readSync(entry.isSensitive, text) !== false) return true;
    }
    return false;
  }

  function accountKey(account) {
    return JSON.stringify([account.platform, account.accountId, account.tenantId]);
  }

  function registerRecoveryAccounts(account) {
    // A verified replacement can clean up journals from previous identities
    // in its platform namespace. Recovery is always against the original ID.
    const originals = [...inbox.recoveryAccounts(), ...(outbox?.recoveryAccounts() ?? [])];
    const registeredKey = accountKey(account);
    recoveryAccounts.delete(registeredKey);
    for (const original of originals) {
      const key = accountKey(original);
      if (original.platform !== account.platform || key === registeredKey || recoveryAccounts.has(key)) continue;
      const policy = { ...original, enabled: false };
      recoveryAccounts.set(key, {
        account: original, binding: inbox.bind(original, () => policy), policy, cursor: 0, failures: new Set(),
      });
    }
  }

  function registerAccount(input, { adapter = null, isCurrent = () => true, observationVerified = false, isSensitive } = {}) {
    if (stopped) throw new Error('Channel host is closed');
    const account = Object.freeze(readAccountRef(input));
    if (!Object.hasOwn(TRANSPORT_CONFIG, account.platform) || typeof isCurrent !== 'function' ||
        typeof observationVerified !== 'boolean' || (isSensitive !== undefined && typeof isSensitive !== 'function') ||
        (adapter !== null && ![adapter.splitText, adapter.sendText].every((fn) => typeof fn === 'function'))) {
      throw new TypeError('Invalid channel account registration');
    }
    const entry = {
      account, adapter, isCurrent, isSensitive, observationVerified, scopes: new Map(),
      policy: null, active: false, transport: null, pollEpoch: 0, cursor: 0, failures: new Set(),
    };
    refreshEntry(entry, readChannels()?.[account.platform]);
    if (!entry.active) throw new Error('Channel account is unavailable');
    entry.binding = inbox.bind(account, () => readPolicy(entry));
    registerRecoveryAccounts(account);
    const prior = accounts.get(account.platform);
    if (prior) clearScopes(prior);
    accounts.set(account.platform, entry);
    reload();

    function isActive() {
      return readPolicy(entry)?.enabled === true;
    }

    function startPolling() {
      if (!isActive()) return null;
      const epoch = entry.pollEpoch;
      const poller = entry.binding.startPolling();
      const isCurrentPoll = () => isActive() && entry.pollEpoch === epoch;
      return {
        readCheckpoint: () => isCurrentPoll() ? poller.readCheckpoint() : null,
        acceptBatch: (events, checkpoint) => isCurrentPoll() ? poller.acceptBatch(events, checkpoint) : STALE_POLL,
      };
    }

    return {
      ...(account.platform === 'feishu'
        ? { accept: (event) => isActive() ? entry.binding.accept(event) : DISABLED }
        : { startPolling }),
      close() {
        if (entryFor(account) !== entry) return;
        clearScopes(entry);
        accounts.delete(account.platform);
      },
    };
  }

  function watch(map, key, entry, lane, work) {
    const promise = Promise.resolve().then(work).then(() => {
      entry.failures.delete(lane);
    }, () => {
      if (!entry.failures.has(lane)) report(`${entry.account.platform} ${lane} worker failed`);
      entry.failures.add(lane);
    }).finally(() => map.delete(key));
    map.set(key, promise);
  }

  function ownsEntry(entry) {
    return entryFor(entry.account) === entry || recoveryAccounts.get(accountKey(entry.account)) === entry;
  }

  function scheduleTurn(entry, dshReady) {
    const { binding } = entry;
    const candidates = new Map();
    if (dshReady) {
      for (const orphan of binding.orphanedTurns(MAX_TURNS)) {
        candidates.set(orphan.dialogueId, () => hosted.reconcileOrphan(binding, orphan.requestId, { retire: orphan.state === 'retiring' }));
      }
    }
    if (entry.policy) {
      for (const { dialogueId, decision, event: { messageKey } } of binding.pending(MAX_QUEUE)) {
        if (candidates.has(dialogueId) || (!dshReady && decision !== 'observe' && entry.policy.enabled)) continue;
        candidates.set(dialogueId, async () => {
          const runner = textToolsAllowed ? textHosted : hosted;
          const result = await runner.run(binding, messageKey);
          if (!stopped && dshReady && result.status === 'retirement_unconfirmed') await runner.retire(binding, messageKey);
        });
      }
    }
    const jobs = [...candidates];
    for (let offset = 0; offset < jobs.length; offset += 1) {
      const index = (entry.cursor + offset) % jobs.length;
      const [dialogueId, run] = jobs[index];
      if (activeTurns.has(dialogueId)) continue;
      entry.cursor = index + 1;
      watch(activeTurns, dialogueId, entry, 'inbound', () => {
        if (!stopped && ownsEntry(entry)) return run();
      });
      return true;
    }
    return jobs.length > 0;
  }

  function tick() {
    if (stopped) return;
    // Platform verification and live tool settings govern dispatch only.
    // Confirmations have their own local recovery path for the original account.
    try {
      for (const account of outbox?.confirmationAccounts() ?? []) {
        const key = accountKey(account);
        try {
          const result = inbox.projectNextConfirmation(account);
          if (result.status === 'retryableFailure') throw new Error('Confirmation projection unavailable');
          projectionFailures.delete(key);
        } catch {
          if (!projectionFailures.has(key)) report(`${account.platform} confirmation projection failed`);
          projectionFailures.add(key);
        }
      }
      projectionFailures.delete('scan');
    } catch {
      if (!projectionFailures.has('scan')) report('confirmation queue scan failed');
      projectionFailures.add('scan');
    }
    reload();
    let ready = false;
    try { ready = readSync(canRunTurns) === true; } catch { /* Keep durable jobs pending. */ }
    const entries = [...accounts.values(), ...recoveryAccounts.values()];
    for (let offset = 0; offset < entries.length; offset += 1) {
      const entry = entries[(accountCursor + offset) % entries.length];
      const recovery = entryFor(entry.account) !== entry;
      try {
        const hasOutput = textHosted && (!recovery || outbox.hasActive(entry.account));
        if (activeTurns.size < MAX_TURNS) {
          const hasPending = scheduleTurn(entry, ready);
          if (!hasPending && ready && recovery && !hasOutput) recoveryAccounts.delete(accountKey(entry.account));
        }
        if (hasOutput && !activeSends.has(entry.account.platform)) {
          watch(activeSends, entry.account.platform, entry, 'outbound', () => {
            if (!stopped && ownsEntry(entry)) {
              return textHosted.deliverNextText(entry.account);
            }
          });
        }
      } catch {
        if (!entry.failures.has('storage')) report(`${entry.account.platform} queue scan failed`);
        entry.failures.add('storage');
        continue;
      }
      entry.failures.delete('storage');
    }
    accountCursor = entries.length ? (accountCursor + 1) % entries.length : 0;
  }

  try {
    const runnerOptions = { api, workspacePath, longMemory, rag, readRoleState, readRoleCard, maxConcurrent: MAX_TURNS };
    hosted = createHostedChannelTurnRunner({ ...runnerOptions, isScopeCurrent: (scope) => isScopeCurrent(scope, false) });
    if (enableTextTools) {
      textHosted = createHostedChannelTurnRunner({
        ...runnerOptions, isScopeCurrent: (scope) => isScopeCurrent(scope, true),
        textTools: { store: outbox, adapterFor, authorizeSource, isSensitive: containsSensitive },
        commonTools: {
          authorizeSource: authorizeCommonSource,
          actions: createChannelCommonTools({
            longMemory, rag, redact: (text) => containsSensitive(text) || SENSITIVE_RE.test(text) ? '***' : text,
          }),
        },
      });
      toolServer = await startChannelToolServer({
        invokeTextTool: textHosted.invokeTextTool, invokeCommonTool: textHosted.invokeCommonTool,
      });
    }
    timer = setInterval(tick, intervalMs);
    timer.unref();
  } catch (error) {
    try { outbox?.close(); } finally { inbox.close(); }
    throw error;
  }

  function close() {
    if (closing) return closing;
    stopped = true;
    clearInterval(timer);
    invalidateAll();
    accounts.clear();
    recoveryAccounts.clear();
    closing = (async () => {
      const results = await Promise.allSettled([toolServer?.close(), ...activeTurns.values(), ...activeSends.values()]);
      try { outbox?.close(); } finally { inbox.close(); }
      for (const result of results) {
        if (result.status === 'rejected') throw new Error('Channel host worker did not close');
      }
    })();
    return closing;
  }

  return {
    registerAccount, privateBindings, reload, invalidateAll, close,
    // Trusted host callers supply an already-authorized account or conversation.
    getDeliveryStatus: (account, operationId) => stopped ? null : outbox?.getDeliveryStatus(account, operationId) ?? null,
    getConversationDeliveryStats: (conversation) => stopped ? null : outbox?.getConversationDeliveryStats(conversation) ?? null,
    toolCredentials: toolServer ? Object.freeze({ port: toolServer.port, secret: toolServer.secret }) : null,
  };
}
