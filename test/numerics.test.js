import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { summarize } from '../src/domain.js';

const seed = JSON.parse(await readFile('data/records.json', 'utf8')).records[0];
const probe = patches => summarize(patches.map((patch, index) => ({...seed, id: `p${index}`, ...patch}))).groups[0];

test('成交额口径按线索总数加权，空分母不编造比率', () => {

  assert.equal(probe([{leads: 1, value: 100}, {leads: 9, value: 90}]).ratio, 19);
  assert.equal(probe([{leads: 0, value: 0}]).ratio, null);
});
