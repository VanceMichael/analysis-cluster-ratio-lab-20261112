const REASON_LABELS = {
  empty_arm: '某分配组没有纳入展商',
  insufficient_clusters: '组内展商不足 2 家',
  singleton_stratum_cell: '存在每层仅 1 家展商的分层单元',
  zero_mean_denominator: '组均有效线索为零',
  nonpositive_denominator: '分母（有效线索合计）不为正',
  ratio_unavailable: '至少一组的主要指标不可计算',
  zero_variance: '组内得分零方差'
};

const fmt = (value, digits = 2) => (value === null || value === undefined ? '不可计算' : value.toFixed(digits));
const fmtP = p => (p === null || p === undefined ? '不可计算' : p < 0.0001 ? '<0.0001' : p.toFixed(4));
const reasonText = reasons => (reasons && reasons.length
  ? reasons.map(code => REASON_LABELS[code] ?? code).join('；')
  : '原因见 diagnostics');

function describeView(label, view, plan) {
  const { control, treatment } = plan;
  const controlArm = view.perArm[control];
  const treatmentArm = view.perArm[treatment];
  const effect = view.effect;
  const confidence = (1 - plan.alpha) * 100;
  if (effect.estimate === null) return `${label}：组间差值不可计算（${reasonText(effect.reasons)}）。`;
  const interval = effect.available
    ? `，${confidence}% 置信区间 [${fmt(effect.ciLower)}, ${fmt(effect.ciUpper)}]，p=${fmtP(effect.pValue)}`
    : `，区间与显著性不可计算（${reasonText(effect.reasons)}）`;
  return `${label}：${control} 组 ${fmt(controlArm.ratio)} 元/条，${treatment} 组 ${fmt(treatmentArm.ratio)} 元/条，`
    + `差值 ${fmt(effect.estimate)} 元${interval}。`;
}

export function buildConclusion(document) {
  const { plan, results, clusters, diagnostics, adoption } = document;
  const { control, treatment } = plan;
  const lines = [];
  lines.push('实验单位：展商（同一展商多天记录成组）；按登记计划分配组做意向分析，实际采用仅作旁列诊断。');
  lines.push('主要指标：每条有效线索成交额 = 各组成交额总和 ÷ 各组有效线索总和（总和之比，不是展商比率的平均）。');
  lines.push(`纳入展商 ${clusters.included} 家（${control} 组 ${clusters.perArm[control] ?? 0} 家，`
    + `${treatment} 组 ${clusters.perArm[treatment] ?? 0} 家）；排除 ${clusters.excluded} 家（去向见 exclusions）。`);
  lines.push(describeView('未调整', results.unadjusted, plan));
  lines.push(describeView('方差缩减（CUPED，仅用实验前 pre_value、pre_leads）', results.adjusted, plan));
  const primary = results[plan.primaryView] ?? results.unadjusted;
  const primaryLabel = plan.primaryView === 'adjusted' ? '方差缩减后' : '未调整';
  if (!primary.effect.available) {
    lines.push(`判断：主要口径（${primaryLabel}）无法给出区间与显著性（${reasonText(primary.effect.reasons)}），不能据此下确定结论。`);
  } else if (primary.effect.pValue < plan.alpha) {
    const direction = primary.effect.estimate > 0 ? '高于' : primary.effect.estimate < 0 ? '低于' : '持平于';
    lines.push(`判断：在 α=${plan.alpha} 水平下，${treatment} 组每条有效线索成交额统计上显著${direction}${control} 组`
      + `（差值 ${fmt(primary.effect.estimate)} 元）。`);
  } else {
    lines.push(`判断：在 α=${plan.alpha} 水平下，现有数据不足以认定 ${treatment} 组每条有效线索成交额相对 ${control} 组有所提升`
      + `（置信区间包含 0）。`);
  }
  if (diagnostics.length > 0) {
    lines.push(`诊断提示：${diagnostics.map(d => d.message).join('；')}。`);
  }
  const adoptionText = plan.arms
    .map(arm => `${arm} 组 ${adoption.perArm[arm].adopted}/${adoption.perArm[arm].clusters} 家实际采用`)
    .join('，');
  lines.push(`旁列诊断：${adoptionText}；实际采用不进入主估计。`);
  lines.push('以上仅为本次展会数据的统计估计，受样本规模与展会情境限制，不构成对下一场展会推广收益的承诺。');
  return lines;
}

export function renderMarkdown(document) {
  const { plan, clusters, exclusions, denominatorRisk, diagnostics, results, adoption } = document;
  const lines = [];
  lines.push('# 展会实验分析报告');
  lines.push('');
  lines.push('## 分析计划');
  lines.push('');
  lines.push(`- 实验单位：${plan.unit}（整组分配，意向分析）`);
  lines.push(`- 分配组：对照 ${plan.control}，处理 ${plan.treatment}`);
  lines.push(`- 分层字段：${plan.strata.join('、')}`);
  lines.push(`- 主要指标：${plan.metric.label}（${plan.metric.type}，${plan.metric.numerator} ÷ ${plan.metric.denominator}）`);
  lines.push(`- 主要口径：${plan.primaryView === 'adjusted' ? '方差缩减后' : '未调整'}；显著性水平 α=${plan.alpha}`);
  lines.push(`- 方差缩减：${plan.adjustment.method}，协变量 分子=${plan.adjustment.covariates.numerator}、分母=${plan.adjustment.covariates.denominator}，`
    + `中心化=${plan.adjustment.centering}，系数 分子=${plan.adjustment.coefficients.numerator}、分母=${plan.adjustment.coefficients.denominator}`);
  lines.push(`- 种子：${plan.seed}；种子指纹：${plan.seedFingerprint}`);
  lines.push(`- 计划指纹：${plan.planFingerprint}`);
  lines.push(`- 输入指纹：${document.inputFingerprint ?? '（未提供）'}`);
  lines.push('');
  lines.push('## 样本与排除');
  lines.push('');
  lines.push(`- 纳入展商 ${clusters.included} 家，排除 ${clusters.excluded} 家`);
  for (const [arm, count] of Object.entries(clusters.perArm)) {
    lines.push(`- ${arm} 组有效组数：${count} 家`);
  }
  for (const [stratum, counts] of Object.entries(clusters.perStratum)) {
    lines.push(`- 分层 ${stratum}：${Object.entries(counts).map(([arm, n]) => `${arm} 组 ${n} 家`).join('，')}`);
  }
  if (exclusions.length > 0) {
    lines.push('- 排除去向：');
    for (const e of exclusions) lines.push(`  - ${e.exhibitor}：${e.reason}（${e.detail}，${e.rows} 行）`);
  }
  lines.push('');
  lines.push('## 分母风险');
  lines.push('');
  for (const [arm, risk] of Object.entries(denominatorRisk.perArm)) {
    lines.push(`- ${arm} 组：有效线索合计 ${risk.leads} 条，平均每展商 ${risk.meanLeadsPerCluster === null ? '不可计算' : risk.meanLeadsPerCluster} 条`
      + `${risk.belowThreshold ? '（低于阈值，分母偏小）' : ''}${risk.zeroLeadExhibitors.length ? `，零线索展商：${risk.zeroLeadExhibitors.join('、')}` : ''}`);
  }
  lines.push('');
  lines.push('## 结果（每条有效线索成交额，元/条）');
  lines.push('');
  lines.push('| 口径 | 组 | 展商数 | 分子合计 | 分母合计 | 比率 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const [viewName, view] of [['未调整', results.unadjusted], ['方差缩减', results.adjusted]]) {
    for (const arm of plan.arms) {
      const a = view.perArm[arm];
      lines.push(`| ${viewName} | ${arm} | ${a.clusters} | ${a.value} | ${a.leads} | ${a.ratio === null ? '不可计算' : a.ratio} |`);
    }
  }
  lines.push('');
  for (const [viewName, view] of [['未调整', results.unadjusted], ['方差缩减', results.adjusted]]) {
    const e = view.effect;
    lines.push(`- ${viewName}差值（${plan.treatment} − ${plan.control}）：${e.estimate === null ? '不可计算' : e.estimate}`
      + (e.available ? `，标准误 ${e.se}，${(1 - plan.alpha) * 100}% 置信区间 [${e.ciLower}, ${e.ciUpper}]，p=${e.pValue}` : `（区间与显著性不可计算：${reasonText(e.reasons)}）`));
  }
  lines.push('');
  lines.push('## 诊断');
  lines.push('');
  if (diagnostics.length === 0) lines.push('- 无');
  for (const d of diagnostics) lines.push(`- [${d.code}] ${d.message}`);
  lines.push('');
  lines.push('## 旁列：实际采用');
  lines.push('');
  lines.push(`- ${adoption.note}`);
  for (const [arm, a] of Object.entries(adoption.perArm)) {
    lines.push(`- ${arm} 组：${a.adopted}/${a.clusters} 家实际采用`);
  }
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  for (const line of document.conclusion.zh) lines.push(`- ${line}`);
  lines.push('');
  return lines.join('\n');
}
