#!/usr/bin/env node
// 情绪判读准确率评估（PERSONA_PATCH，子项目 1 任务 10）。
//
// 来自 docs/design/persona-impl/scripts/eval-persona-appraisal.mjs，按 v2 改了两处：
// ① 判读输入和线上 persona.js 的 inputFor 一样带上「她的性格」和「她的好恶」（从当前角色的 core.json 读），
//    此刻情绪、关系留空——评估只看这句话本身的性质；规则兜底也带好恶。
// ② 只算已标注（expected.kind 有值）的用例，候选可以直接用 persona-eval-cases.mjs 抽的那份。
//
// 用例：state/persona/eval/cases.jsonl（含聊天原文，只放 state/，不入 git），一行一条：
//   { "speaker": "阿青", "text": "你好菜哈哈哈", "context": ["阿青：在吗"], "directed": true,
//     "expected": { "kind": "tease", "target": "me" } }
// 用法：
//   node scripts/eval-persona-appraisal.mjs                 # 模型 + 规则都跑（模型用 state/persona/config.json 的设置与密钥）
//   node scripts/eval-persona-appraisal.mjs --rules-only    # 只跑规则（不联网）
//   node scripts/eval-persona-appraisal.mjs --cases path/to/cases.jsonl
// 输出：kind / target 准确率、「骂 vs 玩笑」混淆表、每条错例（只打印序号与期望/实际，不打印原文）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeSettings, renderCore } from '../src/persona-state.js';
import { ruleAppraise, createDeepSeekClient, createAppraiser } from '../src/persona-appraisal.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const rulesOnly = args.includes('--rules-only');
const casesFile = args.includes('--cases') ? args[args.indexOf('--cases') + 1] : path.join(ROOT, 'state', 'persona', 'eval', 'cases.jsonl');
const configFile = path.join(ROOT, 'state', 'persona', 'config.json');

const all = fs.readFileSync(casesFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const cases = all.filter((c) => c.expected?.kind);
if (!cases.length) { console.error(`${path.relative(ROOT, casesFile)} 里还没有标注过的用例（共 ${all.length} 条）`); process.exit(1); }
if (cases.length < all.length) console.log(`只算已标注的 ${cases.length} 条（共 ${all.length} 条）`);

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch {}
const settings = () => mergeSettings({ ...(cfg.settings ?? {}), appraisal: { ...(cfg.settings?.appraisal ?? {}), mode: 'model', dailyLimit: 100000 } });

// 和 persona.js 的 inputFor 同一套取法；出厂性格没确认过就只评「这句话」，不带性格和好恶。
let role = 'default';
try { role = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'current-role.json'), 'utf8')).role || 'default'; } catch {}
let core = null;
try { core = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'persona', path.basename(role), 'core.json'), 'utf8')); } catch {}
const persona = core ? renderCore(core).split('\n').slice(1).join(' ') : '';
const prefs = (core?.prefs ?? []).map(({ id, text, valence, strength, keywords }) => ({ id, text, valence, strength, keywords }));
console.log(core ? `角色「${role}」：带性格与 ${prefs.length} 条好恶` : `角色「${role}」没有 core.json：不带性格与好恶`);
const inputOf = (c) => ({ persona, prefs, emotion: '', relation: '', context: (c.context ?? []).slice(-6), speaker: c.speaker ?? '对方', text: c.text, directed: !!c.directed });

function score(name, results) {
  let kindOk = 0;
  let targetOk = 0;
  const confusion = { insult: { insult: 0, tease: 0, other: 0 }, tease: { insult: 0, tease: 0, other: 0 } };
  const wrong = [];
  results.forEach((r, i) => {
    const exp = cases[i].expected;
    if (r.kind === exp.kind) kindOk++;
    else wrong.push(`#${all.indexOf(cases[i]) + 1} 期望 ${exp.kind} 实际 ${r.kind}（${r.source}）`);
    if (!exp.target || r.target === exp.target) targetOk++;
    if (confusion[exp.kind]) confusion[exp.kind][['insult', 'tease'].includes(r.kind) ? r.kind : 'other']++;
  });
  console.log(`\n== ${name}（${results.length} 条）`);
  console.log(`kind 准确率 ${(kindOk / results.length * 100).toFixed(1)}%，target 准确率 ${(targetOk / results.length * 100).toFixed(1)}%`);
  console.log('骂 vs 玩笑（行=期望，列=实际）：', JSON.stringify(confusion));
  for (const w of wrong) console.log('  ' + w);
}

score('规则', cases.map((c) => ruleAppraise(inputOf(c))));

if (!rulesOnly) {
  if (!cfg.apiKey) { console.error('\nstate/persona/config.json 里没有 apiKey，跳过模型评估（先在控制台填密钥，或加 --rules-only）'); process.exit(1); }
  const client = createDeepSeekClient({ getSettings: settings, getApiKey: () => cfg.apiKey });
  const appraiser = createAppraiser({ client, getSettings: settings, log: (m) => console.error(m) });
  const modelResults = [];
  for (const c of cases) modelResults.push(await appraiser.appraise(inputOf(c)));
  score('模型', modelResults);
  console.log('\n用量：', JSON.stringify(appraiser.stats()));
}
