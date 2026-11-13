import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadDataset } from './dataset.js';
import { summarize } from './domain.js';
import { analyzeExperiment } from './experiment.js';
import { renderMarkdown } from './report.js';
import { writeResult, writeText } from './output.js';

export function parseArguments(args) {
  const [command = 'summary', ...options] = args;
  if (!['summary', 'inspect', 'experiment'].includes(command)) {
    throw new Error('命令应为 summary、inspect 或 experiment');
  }
  const result = { command, input: 'data/records.json' };
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index];
    const value = options[index + 1];
    if (!['--input', '--out', '--policy', '--report'].includes(name) || !value || value.startsWith('--')) {
      throw new Error('参数应为 --input 路径、--out 路径、--policy 路径或 --report 路径');
    }
    if (result[name.slice(2)] && name !== '--input') throw new Error('参数不可重复');
    result[name.slice(2)] = value;
  }
  if (command !== 'experiment' && (result.policy || result.report)) {
    throw new Error('仅 experiment 命令接受 --policy 或 --report 参数');
  }
  if (command === 'experiment' && !result.policy) result.policy = 'data/policy.json';
  return result;
}

export async function main(args) {
  const options = parseArguments(args);
  const dataset = await loadDataset(options.input);
  let result;
  if (options.command === 'summary') {
    result = summarize(dataset.records);
  } else if (options.command === 'inspect') {
    result = { records: dataset.records.length, fingerprint: dataset.fingerprint,
      fields: dataset.records.length ? Object.keys(dataset.records[0]).sort() : [] };
  } else {
    const policy = JSON.parse(await readFile(options.policy, 'utf8'));
    result = analyzeExperiment(dataset.records, policy);
  }
  const document = { ...result, inputFingerprint: dataset.fingerprint };
  if (options.command === 'experiment' && options.report) {
    await writeText(options.report, renderMarkdown(document));
  }
  if (options.out) await writeResult(options.out, document);
  return document;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }).catch(error => {
    process.stderr.write(`处理失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
