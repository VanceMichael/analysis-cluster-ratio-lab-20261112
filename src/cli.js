import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadDataset } from './dataset.js';
import { summarize } from './domain.js';
import { writeResult } from './output.js';

export function parseArguments(args) {
  const [command = 'summary', ...options] = args;
  if (!['summary', 'inspect'].includes(command)) throw new Error('命令应为 summary 或 inspect');
  const result = { command, input: 'data/records.json' };
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index];
    const value = options[index + 1];
    if (!['--input', '--out'].includes(name) || !value || value.startsWith('--')) {
      throw new Error('参数应为 --input 路径 或 --out 路径');
    }
    if (result[name.slice(2)] && name !== '--input') throw new Error('参数不可重复');
    result[name.slice(2)] = value;
  }
  return result;
}

export async function main(args) {
  const options = parseArguments(args);
  const dataset = await loadDataset(options.input);
  const result = options.command === 'summary' ? summarize(dataset.records)
    : { records: dataset.records.length, fingerprint: dataset.fingerprint,
      fields: dataset.records.length ? Object.keys(dataset.records[0]).sort() : [] };
  const document = { ...result, inputFingerprint: dataset.fingerprint };
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
