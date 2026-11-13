# cluster-ratio-lab

展商按日提交的洽谈与成交核算，金额单位为元，线索数允许为零。

项目目前提供本地记录校验、输入指纹、按 `arm` 的原始核算，以及以展商为实验单位的 `experiment` 分析（意向分析、比率口径、方差缩减与诊断，见 `docs/experiment.md`）。分析人员可以保留完整输入并复查每次导出的 JSON；原始数据不被命令改写。业务配置位于 `data/policy.json`，字段约定在 `docs/data.md`。

## 运行

使用 Node.js 22 LTS（>=22.22.1 且 <23）和 npm，无第三方运行依赖。
`.nvmrc` 选择 22 主版本，清单与锁文件记录相同的兼容范围；Dockerfile 仍固定基础镜像摘要，容器构建可精确复现。

```sh
npm ci --ignore-scripts --no-audit --no-fund --offline
npm run build
npm test
npm run summary
node src/cli.js inspect --input data/records.json
node src/cli.js summary --input data/records.json --out var/summary.json
node src/cli.js experiment --input data/records.json --policy data/policy.json --out var/experiment.json --report var/experiment-report.md
npm run demo
```

`npm run demo` 在本地打印输入、现有核算、实验分析及配置并生成 `var/summary.json`、`var/experiment.json` 与 `var/experiment-report.md`，不访问网络、不等待真实业务时间，通常几秒内完成。输出目录可删除后重新运行，测试只使用临时目录。

## 容器

```sh
docker build -t cluster-ratio-lab:local .
docker run --rm --network none cluster-ratio-lab:local
```

Dockerfile 固定 Node.js 基础镜像摘要，构建时执行语法检查和测试。镜像构建完成后演示无需联网；可覆盖命令运行 `npm test`。构建不需要真实账号、邮件服务、数据库或线上数据。

## 目录

- `src/dataset.js`：记录校验、规范序列化和数据指纹。
- `src/domain.js`：当前业务分组核算。
- `src/experiment.js`：展商整组实验分析（意向分析、CUPED 方差缩减、分层整组比率推断与诊断）。
- `src/report.js`：中文结论与 markdown 报告渲染。
- `src/cli.js`：本地读取、检查和导出入口。
- `src/output.js`：以临时文件写入后替换完整 JSON 或文本。
- `test/`：输入约束、领域核对、命令与输出回归、可手算实验夹具核对。
- `data/`：合成记录、独立核对值及本地业务配置。
- `docs/experiment.md`：实验分析口径与可复核性说明。
