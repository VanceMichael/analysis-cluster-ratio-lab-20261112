import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { schema } from './schema.js';

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function validateRecords(records) {
  if (!Array.isArray(records)) throw new Error('数据必须是记录数组');
  const ids = new Set();
  for (const [index, record] of records.entries()) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`第 ${index + 1} 条记录不是对象`);
    }
    for (const [field, type] of Object.entries(schema)) {
      const value = record[field];
      const valid = type === 'integer' ? Number.isSafeInteger(value)
        : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === type;
      if (!valid) throw new Error(`第 ${index + 1} 条记录的 ${field} 类型应为 ${type}`);
    }
    if (record.id.length === 0 || ids.has(record.id)) throw new Error('记录 id 为空或重复');
    ids.add(record.id);
  }
  return records;
}

export async function loadDataset(path) {
  const document = JSON.parse(await readFile(path, 'utf8'));
  if (document.version !== 1) throw new Error('不支持的数据文件版本');
  validateRecords(document.records);
  return { version: 1, records: document.records, fingerprint: fingerprint(
    [...document.records].sort((left, right) => left.id.localeCompare(right.id, 'en'))
  ) };
}
