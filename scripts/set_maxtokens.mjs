// 把 llm-deepseek / llm-deepseek-account 的 maxTokens 收紧，限制单步输出长度（输出 token 是延迟主因）。
import { PROBE_BASE as BASE, probeCookie, probeRpc } from './probe-auth.mjs';

const rpc = probeRpc(probeCookie({ base: BASE }));
const LIMIT = Number(process.argv[2] || 1024);

const st = await rpc('settings/describe', {});
const namespaces = st?.value?.namespaces ?? [];

for (const ns of ['llm-deepseek', 'llm-deepseek-account']) {
  const cur = namespaces.find((n) => n.ns === ns);
  if (!cur) { console.log(ns, '未出现在 describe 里'); continue; }
  const before = cur.value?.maxTokens;
  const up = await rpc('settings/update', { ns, patch: { maxTokens: LIMIT }, expectedRevision: cur.revision });
  const again = await rpc('settings/describe', {});
  const after = (again?.value?.namespaces ?? []).find((n) => n.ns === ns);
  console.log(`${ns}: maxTokens ${before} -> ${after?.value?.maxTokens} (ok=${up?.ok === true}${up?.ok === true ? '' : ' ' + (up?.error?.message ?? '')})`);
}
