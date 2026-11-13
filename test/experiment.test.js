import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyzeExperiment, buildPlan, normalCdf, normalQuantile, validatePolicy } from '../src/experiment.js';

const sample = JSON.parse(await readFile('data/records.json', 'utf8')).records;
const policy = JSON.parse(await readFile('data/policy.json', 'utf8'));

const row = (id, exhibitor, arm, stratum, leads, value, preLeads, preValue, adopted = false, day = 1) =>
  ({ id, exhibitor, day, stratum, arm, leads, value, pre_leads: preLeads, pre_value: preValue, adopted });

// 可手算夹具：6 家展商，s2 层每单元 1 家（方差不可估计），用于核对原始比率与 CUPED 调整。
const fixture6 = () => [
  row('f01', 'a1', 'A', 's1', 2, 10, 1, 2),
  row('f02', 'a2', 'A', 's1', 4, 20, 3, 4),
  row('f03', 'a3', 'A', 's2', 3, 12, 2, 6),
  row('f04', 'b1', 'B', 's1', 5, 30, 2, 4),
  row('f05', 'b2', 'B', 's1', 8, 44, 4, 8),
  row('f06', 'b3', 'B', 's2', 6, 36, 3, 6)
];

// 可手算夹具：8 家展商，每层每臂 2 家，实验前变量零方差（调整退化为恒等），用于核对分层整组标准误。
const fixture8 = () => [
  row('g01', 'a1', 'A', 's1', 2, 10, 2, 5),
  row('g02', 'a2', 'A', 's1', 4, 20, 2, 5),
  row('g03', 'a3', 'A', 's2', 3, 12, 2, 5),
  row('g04', 'a4', 'A', 's2', 6, 18, 2, 5),
  row('g05', 'b1', 'B', 's1', 5, 30, 2, 5),
  row('g06', 'b2', 'B', 's1', 8, 44, 2, 5),
  row('g07', 'b3', 'B', 's2', 6, 36, 2, 5),
  row('g08', 'b4', 'B', 's2', 4, 24, 2, 5)
];

const miniPolicy = { arms: ['A', 'B'], unit: 'exhibitor', strata: ['stratum'], seed: 7, alpha: 0.05 };

const close = (actual, expected, epsilon = 1e-12) => {
  assert.ok(typeof actual === 'number' && Number.isFinite(actual), `期望有限数，得到 ${actual}`);
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} 与手算值 ${expected} 不一致`);
};

const scanFinite = value => {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `出现非有限数 ${value}`);
  else if (Array.isArray(value)) value.forEach(scanFinite);
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(scanFinite);
};

test('手算核对：原始比率为总和之比，CUPED 系数与调整结果可复算', () => {
  const d = analyzeExperiment(fixture6(), miniPolicy);
  // 手算：R_A = 42/9，R_B = 110/19，Δ = 64/57
  close(d.results.unadjusted.perArm.A.ratio, 42 / 9);
  close(d.results.unadjusted.perArm.B.ratio, 110 / 19);
  close(d.results.unadjusted.effect.estimate, 64 / 57);
  // 手算：中心化均值 (5, 2.5)，θ_value = 100/22 = 50/11，θ_leads = 10/5.5 = 20/11
  close(d.plan.adjustment.covariateMeans.pre_value, 5);
  close(d.plan.adjustment.covariateMeans.pre_leads, 2.5);
  close(d.plan.adjustment.coefficients.numerator, 50 / 11);
  close(d.plan.adjustment.coefficients.denominator, 20 / 11);
  // 手算：调整后 R_A = 612/129，R_B = 1060/179，Δ = 27192/23091
  close(d.results.adjusted.perArm.A.ratio, 612 / 129);
  close(d.results.adjusted.perArm.B.ratio, 1060 / 179);
  close(d.results.adjusted.effect.estimate, 27192 / 23091);
  // s2 层每单元仅 1 家：必须给诊断且不得伪造区间
  assert.ok(d.diagnostics.some(x => x.code === 'singleton_stratum_cell'));
  assert.equal(d.results.unadjusted.effect.available, false);
  assert.equal(d.results.unadjusted.effect.pValue, null);
  assert.equal(d.results.adjusted.effect.se, null);
  scanFinite(d);
});

test('手算核对：分层整组 delta 标准误、区间与显著性', () => {
  const d = analyzeExperiment(fixture8(), miniPolicy);
  const e = d.results.unadjusted.effect;
  // 手算：R_A = 60/15 = 4，R_B = 134/23，Δ = 42/23
  close(d.results.unadjusted.perArm.A.ratio, 4);
  close(d.results.unadjusted.perArm.B.ratio, 134 / 23);
  close(e.estimate, 42 / 23);
  // 手算：Var(R_A) = 8/45，Var(R_B) = 6464/279841
  close(e.se, Math.sqrt(8 / 45 + 6464 / 279841));
  assert.equal(e.available, true);
  const zCrit = normalQuantile(0.975);
  close(e.ciLower, e.estimate - zCrit * e.se, 1e-9);
  close(e.ciUpper, e.estimate + zCrit * e.se, 1e-9);
  assert.ok(e.pValue > 0 && e.pValue < 0.001);
  // 实验前变量零方差：系数置 0，调整退化为恒等，并给出诊断
  assert.equal(d.plan.adjustment.coefficients.numerator, 0);
  assert.deepEqual(d.results.adjusted.perArm, d.results.unadjusted.perArm);
  assert.ok(d.diagnostics.some(x => x.code === 'zero_covariate_variance'));
  scanFinite(d);
});

test('同一展商多天记录成组：拆分日行不改变输出', () => {
  const merged = fixture6();
  const split = [
    row('f01a', 'a1', 'A', 's1', 1, 4, 1, 2, false, 1),
    row('f01b', 'a1', 'A', 's1', 1, 6, 1, 2, false, 2),
    ...fixture6().slice(1)
  ];
  assert.deepEqual(analyzeExperiment(split, miniPolicy), analyzeExperiment(merged, miniPolicy));
});

test('行重排与重复导入不改变同一计划的输出', () => {
  const base = analyzeExperiment(sample, policy);
  const reversed = analyzeExperiment([...sample].reverse(), policy);
  const shuffled = analyzeExperiment(sample.filter((_, i) => i % 2 === 0).concat(sample.filter((_, i) => i % 2 === 1)), policy);
  assert.deepEqual(base, reversed);
  assert.deepEqual(base, shuffled);
  assert.deepEqual(analyzeExperiment(sample, policy), base);
  assert.equal(buildPlan(sample, policy).planFingerprint, buildPlan([...sample].reverse(), policy).planFingerprint);
  const otherSeed = buildPlan(sample, { ...policy, seed: 1 });
  assert.notEqual(otherSeed.seedFingerprint, base.plan.seedFingerprint);
  assert.notEqual(otherSeed.planFingerprint, base.plan.planFingerprint);
});

test('排除去向完整记录且不影响纳入展商核算', () => {
  const records = [
    ...fixture6(),
    row('x01', 'c1', 'C', 's1', 5, 50, 2, 5),
    row('x02a', 'c2', 'A', 's1', 5, 50, 2, 5, false, 1),
    row('x02b', 'c2', 'B', 's1', 5, 50, 2, 5, false, 2),
    row('x03a', 'c3', 'A', 's1', 5, 50, 2, 5, false, 1),
    row('x03b', 'c3', 'A', 's2', 5, 50, 2, 5, false, 2),
    row('x04a', 'c4', 'A', 's1', 5, 50, 2, 5, false, 1),
    row('x04b', 'c4', 'A', 's1', 5, 50, 2, 6, false, 2)
  ];
  const d = analyzeExperiment(records, miniPolicy);
  assert.deepEqual(d.exclusions.map(e => [e.exhibitor, e.reason]), [
    ['c1', 'arm_not_in_plan'],
    ['c2', 'inconsistent_arm'],
    ['c3', 'inconsistent_stratum'],
    ['c4', 'inconsistent_pre']
  ]);
  const baseline = analyzeExperiment(fixture6(), miniPolicy);
  assert.deepEqual(d.results, baseline.results);
  assert.equal(d.clusters.included, 6);
  assert.equal(d.clusters.excluded, 4);
  assert.ok(d.diagnostics.some(x => x.code === 'excluded_exhibitors'));
  scanFinite(d);
});

test('意向分析不随实际采用变化，采用仅作旁列诊断', () => {
  const flipped = sample.map(r => ({ ...r, adopted: !r.adopted }));
  const base = analyzeExperiment(sample, policy);
  const other = analyzeExperiment(flipped, policy);
  assert.deepEqual(other.results, base.results);
  assert.deepEqual(other.plan, base.plan);
  assert.notDeepEqual(other.adoption, base.adoption);
});

test('零成交、零线索、极小分母与超大展商均给诊断', () => {
  const records = [
    ...fixture6(),
    row('z01', 'z1', 'A', 's1', 3, 0, 2, 5),
    row('z02', 'z2', 'B', 's1', 0, 0, 2, 5),
    row('z03', 'z3', 'B', 's2', 9, 100000, 2, 5)
  ];
  const d = analyzeExperiment(records, { ...miniPolicy, thresholds: { minMeanLeadsPerCluster: 100, extremeValueShare: 0.5 } });
  const codes = d.diagnostics.map(x => x.code);
  assert.ok(codes.includes('zero_value_exhibitors'));
  assert.ok(codes.includes('zero_lead_exhibitors'));
  assert.ok(codes.includes('tiny_denominator'));
  assert.ok(codes.includes('extreme_exhibitor'));
  assert.ok(d.diagnostics.find(x => x.code === 'extreme_exhibitor').message.includes('z3'));
  assert.ok(d.denominatorRisk.perArm.A.belowThreshold);
  assert.deepEqual(d.denominatorRisk.perArm.B.zeroLeadExhibitors, ['z2']);
  scanFinite(d);
});

test('分母为零与单层单臂：比率与显著性留空并给诊断，不留 NaN', () => {
  const zeroLeads = analyzeExperiment([
    row('h01', 'a1', 'A', 's1', 2, 10, 1, 2),
    row('h02', 'a2', 'A', 's1', 4, 20, 3, 4),
    row('h03', 'b1', 'B', 's1', 0, 0, 2, 4),
    row('h04', 'b2', 'B', 's1', 0, 0, 4, 8)
  ], miniPolicy);
  assert.equal(zeroLeads.results.unadjusted.perArm.B.ratio, null);
  assert.equal(zeroLeads.results.unadjusted.effect.estimate, null);
  assert.equal(zeroLeads.results.unadjusted.effect.available, false);
  assert.ok(zeroLeads.diagnostics.some(x => x.code === 'nonpositive_denominator'));
  scanFinite(zeroLeads);

  const oneSided = analyzeExperiment(fixture6().filter(r => r.exhibitor !== 'b3'), miniPolicy);
  assert.ok(oneSided.diagnostics.some(x => x.code === 'single_arm_stratum' && x.message.includes('s2')));
  assert.equal(oneSided.results.unadjusted.effect.available, false);
  assert.ok(oneSided.results.unadjusted.effect.estimate !== null);
  scanFinite(oneSided);

  const empty = analyzeExperiment([], miniPolicy);
  assert.equal(empty.clusters.included, 0);
  assert.equal(empty.results.unadjusted.effect.available, false);
  assert.ok(empty.conclusion.zh.some(line => line.includes('不能据此下确定结论')));
  scanFinite(empty);
});

test('样本数据：24 家全纳入、无诊断、比率与成交额口径一致', () => {
  const d = analyzeExperiment(sample, policy);
  assert.equal(d.clusters.included, 24);
  assert.equal(d.clusters.excluded, 0);
  assert.deepEqual(d.diagnostics, []);
  close(d.results.unadjusted.perArm.A.ratio, 10077 / 480);
  close(d.results.unadjusted.perArm.B.ratio, 9599 / 468);
  close(d.results.unadjusted.effect.estimate, 9599 / 468 - 10077 / 480);
  assert.equal(d.results.unadjusted.effect.available, true);
  assert.equal(d.results.adjusted.effect.available, true);
  assert.ok(d.conclusion.zh.some(line => line.includes('不构成对下一场展会推广收益的承诺')));
  assert.ok(d.conclusion.zh.some(line => line.includes('不足以认定')));
  scanFinite(d);
});

test('业务配置校验拒绝非法值', () => {
  assert.throws(() => validatePolicy({ ...miniPolicy, arms: ['A'] }), /arms/);
  assert.throws(() => validatePolicy({ ...miniPolicy, arms: ['A', 'A'] }), /arms/);
  assert.throws(() => validatePolicy({ ...miniPolicy, unit: 'lead' }), /exhibitor/);
  assert.throws(() => validatePolicy({ ...miniPolicy, strata: ['day'] }), /stratum/);
  assert.throws(() => validatePolicy({ ...miniPolicy, seed: 1.5 }), /seed/);
  assert.throws(() => validatePolicy({ ...miniPolicy, alpha: 1 }), /alpha/);
  assert.throws(() => validatePolicy(null), /对象/);
});

test('正态近似函数与已知分位一致', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normalCdf(1.959963984540054) - 0.975) < 1e-6);
  assert.ok(Math.abs(normalQuantile(0.975) - 1.959963984540054) < 1e-6);
  assert.ok(Math.abs(normalQuantile(0.5)) < 1e-9);
  assert.throws(() => normalQuantile(0), /分位数/);
});

test('命令行 experiment 落盘 JSON 与中文报告，重复运行字节一致', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'experiment-'));
  try {
    const jsonPath = join(folder, 'experiment.json');
    const reportPath = join(folder, 'report.md');
    const args = ['src/cli.js', 'experiment', '--out', jsonPath, '--report', reportPath];
    const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stdout, second.stdout);
    const document = JSON.parse(await readFile(jsonPath, 'utf8'));
    assert.deepEqual(JSON.parse(first.stdout), document);
    assert.equal(document.kind, 'experiment_analysis');
    assert.equal(document.plan.unit, 'exhibitor');
    assert.ok(document.plan.planFingerprint.length === 64);
    const report = await readFile(reportPath, 'utf8');
    assert.ok(report.includes('每条有效线索成交额'));
    assert.ok(report.includes('不构成对下一场展会推广收益的承诺'));
    scanFinite(document);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('非 experiment 命令不接受分析参数', () => {
  const run = spawnSync(process.execPath, ['src/cli.js', 'summary', '--policy', 'data/policy.json'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--policy/);
});
