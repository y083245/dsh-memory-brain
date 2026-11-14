import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import yaml from 'js-yaml';

export const CHANNEL_DSH_PRESET = 'channel-chat-v2';
export const CHANNEL_DSH_TEXT_PRESET = 'channel-chat-v2-text';
const channelPresets = new Set([CHANNEL_DSH_PRESET, CHANNEL_DSH_TEXT_PRESET]);

function successfulValue(response) {
  const { result } = response ?? {};
  if (result?.ok === true && !Object.hasOwn(result, 'error')) return result.value;
}

/** Require the live DSH registry to have activated the exact guarded composition. */
export async function confirmChannelPreset(api, { preset = CHANNEL_DSH_PRESET, sessionId, signal } = {}) {
  if (!channelPresets.has(preset)) return false;
  try {
    signal?.throwIfAborted();
    const roster = successfulValue(await api.callUnary('agentPresets/list', {}, signal))?.presets;
    if (!Array.isArray(roster)) return false;
    const rows = roster.filter(row => row?.id === preset);
    if (rows.length !== 1 || Object.hasOwn(rows[0], 'broken')) return false;

    const patchFile = new URL(`../../plugins/qq-agent-presets/presets/${preset}.patch.yml`, import.meta.url);
    const patch = yaml.load(readFileSync(patchFile, 'utf8'));
    const expected = patch[0].insert.find(row => row.config?.id === preset).config.plugins;
    const document = successfulValue(await api.callUnary('agentPresets/read', { agentPreset: preset }, signal));
    if (document?.agentPreset !== preset || typeof document.content !== 'string'
        || !isDeepStrictEqual(yaml.load(document.content), expected)) return false;

    if (sessionId !== undefined) {
      const projection = successfulValue(await api.callUnary('session/projections', { sessionId }, signal));
      if (projection?.values?.agentPreset !== preset) return false;
    }
    signal?.throwIfAborted();
    return true;
  } catch {
    return false;
  }
}
