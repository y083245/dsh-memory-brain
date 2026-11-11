import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import yaml from 'js-yaml';

export const CHANNEL_DSH_PRESET = 'channel-chat-v2';
const patchFile = new URL('../../plugins/qq-agent-presets/presets/channel-chat-v2.patch.yml', import.meta.url);

function successfulValue(response) {
  const { result } = response ?? {};
  if (result?.ok === true && !Object.hasOwn(result, 'error')) return result.value;
}

/** Require the live DSH registry to have activated the exact guarded composition. */
export async function confirmChannelPreset(api, { sessionId, signal } = {}) {
  try {
    signal?.throwIfAborted();
    const roster = successfulValue(await api.callUnary('agentPresets/list', {}, signal))?.presets;
    if (!Array.isArray(roster)) return false;
    const rows = roster.filter(preset => preset?.id === CHANNEL_DSH_PRESET);
    if (rows.length !== 1 || Object.hasOwn(rows[0], 'broken')) return false;

    const patch = yaml.load(readFileSync(patchFile, 'utf8'));
    const expected = patch[0].insert.find(row => row.config?.id === CHANNEL_DSH_PRESET).config.plugins;
    const document = successfulValue(await api.callUnary('agentPresets/read', { agentPreset: CHANNEL_DSH_PRESET }, signal));
    if (document?.agentPreset !== CHANNEL_DSH_PRESET || typeof document.content !== 'string'
        || !isDeepStrictEqual(yaml.load(document.content), expected)) return false;

    if (sessionId !== undefined) {
      const projection = successfulValue(await api.callUnary('session/projections', { sessionId }, signal));
      if (projection?.values?.agentPreset !== CHANNEL_DSH_PRESET) return false;
    }
    signal?.throwIfAborted();
    return true;
  } catch {
    return false;
  }
}
