import { validateRecords, fingerprint } from './dataset.js';
import { buildConclusion } from './report.js';

// 正态分布累积函数，Abramowitz–Stegun 7.1.26 误差函数近似，绝对误差不超过 1.5e-7。
export function normalCdf(z) {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

// 正态分布分位数，Acklam 有理逼近。
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new Error('分位数概率应在 (0,1) 内');
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - low) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
    / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

export function validatePolicy(policy) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('业务配置必须是对象');
  }
  const { arms, unit, strata, seed, alpha } = policy;
  if (!Array.isArray(arms) || arms.length !== 2 || new Set(arms).size !== 2
    || arms.some(arm => typeof arm !== 'string' || arm.length === 0)) {
    throw new Error('业务配置 arms 应为两个不同的非空字符串');
  }
  if (unit !== 'exhibitor') throw new Error('实验单位仅支持 exhibitor');
  if (!Array.isArray(strata) || strata.length !== 1 || strata[0] !== 'stratum') {
    throw new Error('分层字段仅支持 stratum');
  }
  if (!Number.isSafeInteger(seed)) throw new Error('业务配置 seed 应为安全整数');
  if (typeof alpha !== 'number' || !(alpha > 0 && alpha < 1)) {
    throw new Error('业务配置 alpha 应在 (0,1) 内');
  }
  const raw = policy.thresholds ?? {};
  const minMeanLeadsPerCluster = raw.minMeanLeadsPerCluster ?? 1;
  const extremeValueShare = raw.extremeValueShare ?? 0.5;
  if (typeof minMeanLeadsPerCluster !== 'number' || !Number.isFinite(minMeanLeadsPerCluster) || minMeanLeadsPerCluster < 0) {
    throw new Error('业务配置 thresholds.minMeanLeadsPerCluster 应为非负有限数');
  }
  if (typeof extremeValueShare !== 'number' || !(extremeValueShare > 0 && extremeValueShare <= 1)) {
    throw new Error('业务配置 thresholds.extremeValueShare 应在 (0,1] 内');
  }
  return {
    arms: [...arms], unit, strata: [...strata], seed, alpha,
    thresholds: { minMeanLeadsPerCluster, extremeValueShare }
  };
}

export const EXCLUSION_LABELS = {
  inconsistent_arm: '同一展商出现多个分配组',
  arm_not_in_plan: '分配组不在登记计划内',
  inconsistent_stratum: '同一展商出现多个分层',
  inconsistent_pre: '同一展商实验前变量不一致'
};

// 同一展商的多天记录在此成组；按记录键排序后累加，行序不影响结果。
function collectExhibitors(records) {
  const sorted = [...records].sort((left, right) => left.id.localeCompare(right.id, 'en'));
  const map = new Map();
  for (const row of sorted) {
    if (!map.has(row.exhibitor)) {
      map.set(row.exhibitor, {
        exhibitor: row.exhibitor, value: 0, leads: 0, rows: 0, adopted: false,
        arms: new Set(), strata: new Set(), preValues: new Set(), preLeads: new Set()
      });
    }
    const entry = map.get(row.exhibitor);
    entry.value += row.value;
    entry.leads += row.leads;
    entry.rows += 1;
    entry.adopted = entry.adopted || row.adopted;
    entry.arms.add(row.arm);
    entry.strata.add(row.stratum);
    entry.preValues.add(row.pre_value);
    entry.preLeads.add(row.pre_leads);
  }
  return [...map.values()].sort((left, right) => left.exhibitor.localeCompare(right.exhibitor, 'en'));
}

function classifyExclusion(entry, policy) {
  if (entry.arms.size > 1) return 'inconsistent_arm';
  if (!policy.arms.includes([...entry.arms][0])) return 'arm_not_in_plan';
  if (entry.strata.size > 1) return 'inconsistent_stratum';
  if (entry.preValues.size > 1 || entry.preLeads.size > 1) return 'inconsistent_pre';
  return null;
}

function prepare(records, policy) {
  validateRecords(records);
  const normalized = validatePolicy(policy);
  const included = [];
  const exclusions = [];
  for (const entry of collectExhibitors(records)) {
    const reason = classifyExclusion(entry, normalized);
    if (reason) {
      exclusions.push({ exhibitor: entry.exhibitor, reason, detail: EXCLUSION_LABELS[reason], rows: entry.rows });
      continue;
    }
    included.push({
      exhibitor: entry.exhibitor,
      arm: [...entry.arms][0],
      stratum: [...entry.strata][0],
      value: entry.value,
      leads: entry.leads,
      preValue: [...entry.preValues][0],
      preLeads: [...entry.preLeads][0],
      adopted: entry.adopted,
      rows: entry.rows
    });
  }
  return { policy: normalized, included, exclusions };
}

// CUPED 系数：仅用实验前变量作协变量， pooled OLS 斜率，中心化取全部纳入展商的 pooled 均值。
// 实验后变量（leads、value、adopted）不作为协变量参与调整。
function fitCuped(included) {
  const n = included.length;
  if (n === 0) {
    return {
      thetaValue: 0, thetaLeads: 0, meanPreValue: 0, meanPreLeads: 0,
      zeroVariance: { pre_value: true, pre_leads: true }
    };
  }
  const meanPreValue = included.reduce((sum, e) => sum + e.preValue, 0) / n;
  const meanPreLeads = included.reduce((sum, e) => sum + e.preLeads, 0) / n;
  const meanValue = included.reduce((sum, e) => sum + e.value, 0) / n;
  const meanLeads = included.reduce((sum, e) => sum + e.leads, 0) / n;
  let sxx = 0, sxy = 0, szz = 0, slz = 0;
  for (const e of included) {
    sxx += (e.preValue - meanPreValue) ** 2;
    sxy += (e.preValue - meanPreValue) * (e.value - meanValue);
    szz += (e.preLeads - meanPreLeads) ** 2;
    slz += (e.preLeads - meanPreLeads) * (e.leads - meanLeads);
  }
  return {
    thetaValue: sxx === 0 ? 0 : sxy / sxx,
    thetaLeads: szz === 0 ? 0 : slz / szz,
    meanPreValue,
    meanPreLeads,
    zeroVariance: { pre_value: sxx === 0, pre_leads: szz === 0 }
  };
}

function buildPlanFrom({ policy, included }) {
  const cuped = fitCuped(included);
  const base = {
    version: 1,
    unit: policy.unit,
    arms: [...policy.arms],
    control: policy.arms[0],
    treatment: policy.arms[1],
    strata: [...policy.strata],
    metric: {
      name: 'value_per_valid_lead',
      label: '每条有效线索成交额',
      type: 'ratio_of_sums',
      numerator: 'value',
      denominator: 'leads',
      estimand: 'treatment_minus_control'
    },
    primaryView: 'adjusted',
    adjustment: {
      method: 'cuped',
      covariates: { numerator: 'pre_value', denominator: 'pre_leads' },
      centering: 'pooled_mean',
      coefficientRule: 'pooled_ols_slope',
      coefficients: { numerator: cuped.thetaValue, denominator: cuped.thetaLeads },
      covariateMeans: { pre_value: cuped.meanPreValue, pre_leads: cuped.meanPreLeads },
      zeroCovariateVariance: cuped.zeroVariance,
      postExperimentVariablesUsed: false
    },
    alpha: policy.alpha,
    seed: policy.seed,
    thresholds: { ...policy.thresholds },
    includedExhibitors: included.map(e => ({ exhibitor: e.exhibitor, arm: e.arm, stratum: e.stratum }))
  };
  const seedFingerprint = fingerprint({ seed: policy.seed, arms: policy.arms, strata: policy.strata, unit: policy.unit });
  const planFingerprint = fingerprint(base);
  return { ...base, seedFingerprint, planFingerprint };
}

export function buildPlan(records, policy) {
  return buildPlanFrom(prepare(records, policy));
}

function armSummary(entries) {
  const clusters = entries.length;
  const value = entries.reduce((sum, e) => sum + e.y, 0);
  const leads = entries.reduce((sum, e) => sum + e.l, 0);
  return { clusters, value, leads, ratio: leads > 0 ? value / leads : null };
}

// 分层整组 delta 方法：组内得分 d_i = y_i - R·l_i，方差按 stratum×arm 单元估计，
// 线索行不是独立样本，只有展商（整组）进入方差估计。
function armVariance(entries, ratio) {
  const n = entries.length;
  if (n < 2) return { variance: null, reason: 'insufficient_clusters' };
  const meanLeads = entries.reduce((sum, e) => sum + e.l, 0) / n;
  if (meanLeads === 0) return { variance: null, reason: 'zero_mean_denominator' };
  const cells = new Map();
  for (const e of entries) {
    if (!cells.has(e.stratum)) cells.set(e.stratum, []);
    cells.get(e.stratum).push(e);
  }
  let varianceOfMean = 0;
  for (const cell of cells.values()) {
    const m = cell.length;
    if (m < 2) return { variance: null, reason: 'singleton_stratum_cell' };
    const scores = cell.map(e => e.y - ratio * e.l);
    const mean = scores.reduce((sum, x) => sum + x, 0) / m;
    const s2 = scores.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (m - 1);
    varianceOfMean += (m / n) ** 2 * (s2 / m);
  }
  return { variance: varianceOfMean / (meanLeads * meanLeads), reason: null };
}

function estimateView(entries, policy, adjustment) {
  const perArm = {};
  const variances = {};
  const reasons = new Set();
  for (const arm of policy.arms) {
    const armEntries = entries.filter(e => e.arm === arm);
    perArm[arm] = armSummary(armEntries);
    if (armEntries.length === 0) variances[arm] = { variance: null, reason: 'empty_arm' };
    else if (perArm[arm].ratio === null) variances[arm] = { variance: null, reason: 'nonpositive_denominator' };
    else variances[arm] = armVariance(armEntries, perArm[arm].ratio);
    if (variances[arm].reason) reasons.add(variances[arm].reason);
  }
  const [control, treatment] = policy.arms;
  const effect = {
    estimate: null, se: null, ciLower: null, ciUpper: null, pValue: null,
    alpha: policy.alpha, zCrit: normalQuantile(1 - policy.alpha / 2),
    method: 'stratified_cluster_delta', available: false, reasons: []
  };
  if (perArm[control].ratio !== null && perArm[treatment].ratio !== null) {
    effect.estimate = perArm[treatment].ratio - perArm[control].ratio;
  } else {
    reasons.add('ratio_unavailable');
  }
  if (effect.estimate !== null && variances[control].variance !== null && variances[treatment].variance !== null) {
    const se = Math.sqrt(variances[control].variance + variances[treatment].variance);
    if (se > 0) {
      effect.se = se;
      effect.ciLower = effect.estimate - effect.zCrit * se;
      effect.ciUpper = effect.estimate + effect.zCrit * se;
      effect.pValue = Math.min(1, 2 * normalCdf(-Math.abs(effect.estimate / se)));
      effect.available = true;
    } else {
      reasons.add('zero_variance');
    }
  }
  effect.reasons = [...reasons].sort();
  return { adjustment, perArm, effect };
}

function buildDiagnostics({ included, exclusions, policy, plan, perStratum, denominatorRisk, results }) {
  const diagnostics = [];
  const push = (code, message, details) => diagnostics.push({ code, message, details });
  if (exclusions.length > 0) {
    const reasons = {};
    for (const e of exclusions) reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
    push('excluded_exhibitors',
      `排除展商 ${exclusions.length} 家（${Object.entries(reasons).map(([k, v]) => `${k}:${v}`).join('，')}），不计入任何核算`,
      { reasons, exhibitors: exclusions.map(e => e.exhibitor) });
  }
  const zeroValue = included.filter(e => e.value === 0).map(e => e.exhibitor);
  if (zeroValue.length > 0) {
    push('zero_value_exhibitors', `零成交展商 ${zeroValue.length} 家：${zeroValue.join('、')}`, { exhibitors: zeroValue });
  }
  const zeroLead = included.filter(e => e.leads === 0).map(e => e.exhibitor);
  if (zeroLead.length > 0) {
    push('zero_lead_exhibitors', `有效线索为零的展商 ${zeroLead.length} 家：${zeroLead.join('、')}（不贡献分母）`, { exhibitors: zeroLead });
  }
  for (const [arm, risk] of Object.entries(denominatorRisk.perArm)) {
    if (risk.clusters > 0 && !risk.positive) {
      push('nonpositive_denominator', `${arm} 组有效线索合计不为正，主要指标不可计算`, { arm, leads: risk.leads });
    } else if (risk.belowThreshold) {
      push('tiny_denominator',
        `${arm} 组平均每展商有效线索 ${risk.meanLeadsPerCluster} 条，低于阈值 ${denominatorRisk.thresholdMeanLeadsPerCluster}，分母偏小，比率需谨慎解读`,
        { arm, meanLeadsPerCluster: risk.meanLeadsPerCluster, threshold: denominatorRisk.thresholdMeanLeadsPerCluster });
    }
  }
  for (const arm of policy.arms) {
    const adjustedLeads = results.adjusted.perArm[arm].leads;
    if (results.adjusted.perArm[arm].clusters > 0 && !(adjustedLeads > 0)) {
      push('adjusted_denominator_not_positive', `方差缩减后 ${arm} 组分母不为正，调整后指标不可计算`, { arm, leads: adjustedLeads });
    }
  }
  for (const [stratum, counts] of Object.entries(perStratum)) {
    const present = policy.arms.filter(arm => counts[arm] > 0);
    if (present.length === 1) {
      push('single_arm_stratum', `分层 ${stratum} 只出现 ${present[0]} 组，层内无对照`, { stratum, arms: present });
    }
    for (const arm of policy.arms) {
      if (counts[arm] === 1) {
        push('singleton_stratum_cell', `分层单元 ${stratum}/${arm} 仅 1 家展商，层内方差不可估计`, { stratum, arm });
      }
    }
  }
  for (const arm of policy.arms) {
    const clusters = denominatorRisk.perArm[arm].clusters;
    if (clusters === 0) push('empty_arm', `${arm} 组没有纳入展商`, { arm });
    else if (clusters < 2) push('insufficient_clusters', `${arm} 组纳入展商不足 2 家，方差不可估计`, { arm, clusters });
  }
  for (const arm of policy.arms) {
    const members = included.filter(e => e.arm === arm);
    const totalAbs = members.reduce((sum, e) => sum + Math.abs(e.value), 0);
    if (totalAbs === 0) continue;
    for (const e of members) {
      const share = Math.abs(e.value) / totalAbs;
      if (share > policy.thresholds.extremeValueShare) {
        push('extreme_exhibitor',
          `展商 ${e.exhibitor} 占 ${arm} 组成交额绝对值 ${(share * 100).toFixed(1)}%，超过阈值 ${(policy.thresholds.extremeValueShare * 100).toFixed(0)}%`,
          { exhibitor: e.exhibitor, arm, share, threshold: policy.thresholds.extremeValueShare });
      }
    }
  }
  const zeroCov = plan.adjustment.zeroCovariateVariance;
  for (const field of ['pre_value', 'pre_leads']) {
    if (zeroCov[field] && included.length > 0) {
      push('zero_covariate_variance', `实验前变量 ${field} 方差为零，对应调整系数置 0`, { field });
    }
  }
  return diagnostics;
}

export function analyzeExperiment(records, policy) {
  const prepared = prepare(records, policy);
  const { included, exclusions } = prepared;
  const normalized = prepared.policy;
  const plan = buildPlanFrom(prepared);
  const { coefficients, covariateMeans } = plan.adjustment;

  const rawEntries = included.map(e => ({ exhibitor: e.exhibitor, arm: e.arm, stratum: e.stratum, y: e.value, l: e.leads }));
  const adjustedEntries = included.map(e => ({
    exhibitor: e.exhibitor, arm: e.arm, stratum: e.stratum,
    y: e.value - coefficients.numerator * (e.preValue - covariateMeans.pre_value),
    l: e.leads - coefficients.denominator * (e.preLeads - covariateMeans.pre_leads)
  }));

  const results = {
    primaryView: plan.primaryView,
    unadjusted: estimateView(rawEntries, normalized, 'none'),
    adjusted: estimateView(adjustedEntries, normalized, 'cuped')
  };

  const perArm = {};
  const adoptionPerArm = {};
  const denominatorPerArm = {};
  for (const arm of normalized.arms) {
    const members = included.filter(e => e.arm === arm);
    const clusters = members.length;
    const leads = members.reduce((sum, e) => sum + e.leads, 0);
    const adopted = members.filter(e => e.adopted).length;
    perArm[arm] = clusters;
    adoptionPerArm[arm] = { clusters, adopted, share: clusters === 0 ? null : adopted / clusters };
    denominatorPerArm[arm] = {
      clusters,
      leads,
      meanLeadsPerCluster: clusters === 0 ? null : leads / clusters,
      positive: leads > 0,
      belowThreshold: clusters > 0 && leads > 0 && leads / clusters < normalized.thresholds.minMeanLeadsPerCluster,
      zeroLeadExhibitors: members.filter(e => e.leads === 0).map(e => e.exhibitor)
    };
  }
  const perStratum = {};
  for (const e of included) {
    if (!perStratum[e.stratum]) perStratum[e.stratum] = Object.fromEntries(normalized.arms.map(arm => [arm, 0]));
    perStratum[e.stratum][e.arm] += 1;
  }

  const document = {
    kind: 'experiment_analysis',
    plan,
    clusters: {
      included: included.length,
      excluded: exclusions.length,
      perArm,
      perStratum
    },
    exclusions,
    denominatorRisk: {
      thresholdMeanLeadsPerCluster: normalized.thresholds.minMeanLeadsPerCluster,
      perArm: denominatorPerArm
    },
    adoption: {
      note: '实际采用（adopted）仅作旁列诊断，主估计按登记计划分配组做意向分析',
      perArm: adoptionPerArm
    },
    diagnostics: [],
    results
  };
  document.diagnostics = buildDiagnostics({
    included, exclusions, policy: normalized, plan,
    perStratum, denominatorRisk: document.denominatorRisk, results
  });
  document.conclusion = { zh: buildConclusion(document) };
  return document;
}
