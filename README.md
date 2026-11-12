# cluster-ratio-lab

展商按日提交的洽谈与成交核算，金额单位为元，线索数允许为零。

项目目前提供本地记录校验、输入指纹和按 `arm` 的原始核算。分析人员可以保留完整输入并复查每次导出的 JSON；原始数据不被命令改写。业务配置位于 `data/policy.json`，字段约定在 `docs/data.md`。

## 运行

使用 Node.js 22.22.1 和 npm，无第三方运行依赖。

```sh
npm ci --ignore-scripts --no-audit --no-fund --offline
npm run build
npm test
npm start
node src/cli.js inspect --input data/records.json
node src/cli.js summary --input data/records.json --out var/summary.json
npm run demo
```

`npm run demo` 在本地打印输入、现有核算及配置并生成 `var/summary.json`，不访问网络、不等待真实业务时间，通常几秒内完成。输出目录可删除后重新运行，测试只使用临时目录。

## 容器

```sh
docker build -t cluster-ratio-lab:local .
docker run --rm --network none cluster-ratio-lab:local
```

Dockerfile 固定 Node.js 基础镜像摘要，构建时执行语法检查和测试。镜像构建完成后演示无需联网；可覆盖命令运行 `npm test`。构建不需要真实账号、邮件服务、数据库或线上数据。

## 目录

- `src/dataset.js`：记录校验、规范序列化和数据指纹。
- `src/domain.js`：当前业务分组核算。
- `src/cli.js`：本地读取、检查和导出入口。
- `src/output.js`：以临时文件写入后替换完整 JSON。
- `test/`：输入约束、领域核对、命令与输出回归。
- `data/`：合成记录、独立核对值及本地业务配置。
