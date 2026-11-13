# 实验分析口径（experiment 命令）

`experiment` 在原始核算之外提供实验分析：回答“每条有效线索的成交额是否提升”，并给出该判断能否支持进一步决策所需的区间、显著性与诊断。结论仅为统计估计，不构成推广收益承诺。

## 实验单位与分配

- 实验单位是**展商**（`exhibitor`）。同一展商的多天记录在分析前成组汇总；线索行、成交行都不是独立样本，只有展商进入方差估计。
- 主分析为**意向分析（ITT）**：按登记计划的 `arm` 分组，实际采用（`adopted`）只作旁列诊断，不改变分组。
- 分层字段为 `stratum`，分配在层内整组进行；方差估计尊重 stratum × arm 单元结构。

## 主要指标

每条有效线索成交额 = 组内成交额总和 ÷ 组内有效线索总和（`ratio_of_sums`）。这是总和之比，**不是**展商比率平均。估计目标为处理组减对照组（`policy.arms` 第二个减第一个）。

## 方差缩减（CUPED）

允许且仅允许用实验前变量 `pre_value`、`pre_leads` 做方差缩减：

- 中心化：全部纳入展商的 pooled 均值（`pooled_mean`）。
- 系数：pooled OLS 斜率（`pooled_ols_slope`），分子用 `pre_value`、分母用 `pre_leads`。
- 实验后变量（`leads`、`value`、`adopted`）不参与调整。
- 系数、中心化规则、协变量均值全部记录在 `plan.adjustment`，并计入计划指纹。

## 区间与显著性

比率估计的方差用分层整组 delta 方法：组内得分 `d_i = y_i − R·l_i`，按 stratum × arm 单元估计样本方差后按单元占比加权，再除以组均分母的平方。组间差值的标准误为两组方差之和的平方根，区间与双侧 p 值用正态近似（α 取 `policy.alpha`）。

以下情形不伪造确定结论：估计值能算则照实给出，但区间与 p 值留空（`null`），并在 `effect.reasons` 与 `diagnostics` 说明：

- 某组展商不足 2 家（`insufficient_clusters`）或没有展商（`empty_arm`）；
- 某 stratum × arm 单元仅 1 家展商（`singleton_stratum_cell`）；
- 分母不为正（`nonpositive_denominator`）或组内得分零方差（`zero_variance`）。

## 计划与分析档案

`plan` 保存纳入展商清单、分层、主要指标、调整规则、阈值、种子与两个指纹：`seedFingerprint`（种子与分配方案）和 `planFingerprint`（完整计划）。分析档案另含：

- `exclusions`：排除去向（同一展商多个 arm、arm 不在计划、多个分层、实验前变量不一致），被排除展商不进入任何核算；
- `clusters`：有效组数（按 arm、按 stratum × arm）；
- `denominatorRisk`：各组有效线索合计、组均、零线索展商、是否低于阈值；
- `diagnostics`：零成交展商、极小分母、单层单臂、超大展商（占比超阈值）、零方差协变量等；
- `adoption`：各组实际采用旁列统计。

## 可复核性

- 输出对行重排、重复导入不变：展商按名称排序、行内按记录键排序后汇总，同一计划的输出逐字节一致。
- 测试用可手算的 6 家、8 家展商数据核对原始比率、CUPED 系数、调整比率与分层整组标准误。
- 任何输出都不含 NaN/Infinity：不可计算的量一律为 `null` 并附诊断。

## 运行

```sh
node src/cli.js experiment --input data/records.json --policy data/policy.json --out var/experiment.json --report var/experiment-report.md
```

`--policy` 缺省为 `data/policy.json`；`--report` 可选，输出中文 markdown 报告；JSON 中 `conclusion.zh` 为同一份中文结论。
