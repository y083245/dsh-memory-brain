import { spawnDetached, stopPid } from './process.mjs';

const HANDOFF = 'QQB_CHANNEL_TOOL_HANDOFF';
const PORT_ENV = 'DSH_CHANNEL_TOOL_PORT';
const SECRET_ENV = 'DSH_CHANNEL_TOOL_SECRET';
const MESSAGE = 'qqb:channel-tool-listener:v1';
const HANDOFF_KEYS = new Set([HANDOFF, PORT_ENV, SECRET_ENV]);

export function channelTextToolsEnabled(config) {
  const channels = config?.channels;
  return channels?.textTools === true &&
    (channels.feishu?.enabled === true || channels.telegram?.enabled === true);
}

export function withoutChannelToolEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !HANDOFF_KEYS.has(key.toUpperCase())));
}

export function withoutChannelPlatformEnv(env, config) {
  const channels = config?.channels;
  const names = [
    channels?.feishu?.appSecretEnv || 'FEISHU_APP_SECRET',
    channels?.telegram?.botTokenEnv || 'TELEGRAM_BOT_TOKEN',
    channels?.telegram?.proxyUrlEnv || 'TELEGRAM_PROXY_URL',
  ];
  const keys = new Set(names.filter((name) => typeof name === 'string').map((name) => name.toUpperCase()));
  return Object.fromEntries(Object.entries(env).filter(([key]) => !keys.has(key.toUpperCase())));
}

function validCredentials({ port, secret } = {}) {
  return Number.isInteger(port) && port > 0 && port <= 65535 &&
    typeof secret === 'string' && /^[0-9a-f]{64}$/.test(secret);
}

export function channelToolDshEnv(env, credentials) {
  const sanitized = withoutChannelToolEnv(env);
  if (!credentials) return sanitized;
  if (!validCredentials(credentials)) throw new TypeError('Invalid channel tool listener credentials');
  return { ...sanitized, [PORT_ENV]: String(credentials.port), [SECRET_ENV]: credentials.secret };
}

export function expectsChannelToolCredentials(proc = process) {
  return proc.connected === true && typeof proc.send === 'function' && proc.env[HANDOFF] === '1';
}

export function publishChannelToolCredentials(credentials, proc = process) {
  if (!expectsChannelToolCredentials(proc)) return Promise.resolve(false);
  delete proc.env[HANDOFF];
  if (credentials !== null && (!credentials || !validCredentials(credentials))) return Promise.resolve(false);
  const message = credentials === null
    ? { type: MESSAGE, status: 'unavailable' }
    : { type: MESSAGE, status: 'ready', port: credentials.port, secret: credentials.secret };
  return new Promise((resolve) => {
    try { proc.send(message, (error) => resolve(!error)); }
    catch { resolve(false); }
  });
}

function waitForCredentials(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    function finish(error, credentials) {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('disconnect', onExit);
      child.off('error', onExit);
      if (error) reject(new Error(error));
      else resolve(credentials);
    }

    function onMessage(message) {
      if (message?.type !== MESSAGE) return;
      const keys = Object.keys(message);
      if (message.status === 'unavailable' && keys.length === 2) finish(null, null);
      else if (message.status === 'ready' && keys.length === 4 && validCredentials(message)) {
        finish(null, { port: message.port, secret: message.secret });
      } else finish('Invalid channel tool bridge readiness');
    }

    function onExit() {
      finish('Channel tool bridge exited before readiness');
    }

    const timer = setTimeout(() => finish('Channel tool bridge readiness timed out'), timeoutMs);
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('disconnect', onExit);
    child.once('error', onExit);
  });
}

/** Keep listener credentials on a private startup IPC connection. */
export async function launchChannelToolBridge({ env = process.env, timeoutMs = 30_000, ...spec }) {
  const { pid, child } = await spawnDetached({ ...spec, env: { ...withoutChannelToolEnv(env), [HANDOFF]: '1' }, ipc: true });
  try {
    return { pid, credentials: await waitForCredentials(child, timeoutMs) };
  } catch (error) {
    const result = await stopPid(pid, { timeoutMs: 5_000 });
    if (!result.ok) throw new Error('Channel tool bridge failed to stop after startup failure');
    throw error;
  } finally {
    if (child.connected) child.disconnect();
  }
}
