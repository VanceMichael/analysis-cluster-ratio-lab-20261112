import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonical, fingerprint, loadDataset, validateRecords } from '../src/dataset.js';
import { summarize } from '../src/domain.js';
import { parseArguments } from '../src/cli.js';
import { writeResult } from '../src/output.js';
import { schema } from '../src/schema.js';

const sample = JSON.parse(await readFile('data/records.json', 'utf8')).records;

test('演练数据满足字段类型与唯一记录约束', () => {
  assert.equal(validateRecords(sample), sample);
  assert.ok(sample.length >= 24);
});

test('缺失字段和不安全数值不能进入核算', () => {
  const invalid = { ...sample[0] };
  const field = Object.keys(schema).find(name => name !== 'id');
  delete invalid[field];
  assert.throws(() => validateRecords([invalid]), /类型/);
  const numeric = Object.keys(schema).find(name => ['number','integer'].includes(schema[name]));
  if (numeric) assert.throws(() => validateRecords([{...sample[0], [numeric]: Infinity}]), /类型/);
});

test('空键、重复键和非对象行被拒绝', () => {
  assert.throws(() => validateRecords([{ ...sample[0], id: '' }]), /id/);
  assert.throws(() => validateRecords([sample[0], sample[0]]), /重复/);
  assert.throws(() => validateRecords([null]), /对象/);
});

test('数据指纹不依赖字段顺序', () => {
  assert.equal(fingerprint({a: 1, b: 2}), fingerprint({b: 2, a: 1}));
  assert.deepEqual(canonical({b: [2,1], a: 0}), {a: 0, b: [2,1]});
});

test('清点记录守恒，反向输入不改变输出', () => {
  const result = summarize(sample);
  assert.equal(result.count, sample.length);
  assert.equal(result.groups.reduce((sum, group) => sum + group.count, 0), sample.length);
  assert.deepEqual(result, summarize([...sample].reverse()));
  assert.deepEqual(summarize([]).groups, []);
});

test('文件读取校验版本且指纹不依赖行序', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'records-'));
  try {
    const path = join(folder, 'records.json');
    await writeFile(path, JSON.stringify({version: 1, records: [...sample].reverse()}));
    const original = await loadDataset('data/records.json');
    assert.equal((await loadDataset(path)).fingerprint, original.fingerprint);
    await writeFile(path, JSON.stringify({version: 2, records: []}));
    await assert.rejects(loadDataset(path), /版本/);
  } finally { await rm(folder, {recursive: true, force: true}); }
});

test('输出为完整 JSON 且不留下临时片段', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'output-'));
  try {
    const path = join(folder, 'nested', 'result.json');
    await Promise.all([writeResult(path, {revision:1}), writeResult(path, {revision:2})]);
    assert.ok([1,2].includes(JSON.parse(await readFile(path, 'utf8')).revision));
    assert.deepEqual(await readdir(join(folder, 'nested')), ['result.json']);
  } finally { await rm(folder, {recursive: true, force: true}); }
});

test('命令行读入、落盘与错误退出码可复核', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'cli-'));
  try {
    const path = join(folder, 'summary.json');
    const run = spawnSync(process.execPath, ['src/cli.js','summary','--out',path], {encoding:'utf8'});
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), JSON.parse(await readFile(path, 'utf8')));
    assert.equal(spawnSync(process.execPath, ['src/cli.js','unknown']).status, 1);
  } finally { await rm(folder, {recursive: true, force: true}); }
});

test('参数不接收悬空选项或任意命令', () => {
  assert.equal(parseArguments([]).command, 'summary');
  assert.throws(() => parseArguments(['summary','--out']), /参数/);
  assert.throws(() => parseArguments(['delete']), /命令/);
});
