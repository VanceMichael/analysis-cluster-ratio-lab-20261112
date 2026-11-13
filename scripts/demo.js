import { main } from '../src/cli.js';
import { readFile } from 'node:fs/promises';

const started = performance.now();
console.log('读取本地演练记录并核对输入指纹');
console.log(JSON.stringify(await main(['inspect']), null, 2));
console.log('现有领域核算');
console.log(JSON.stringify(await main(['summary','--out','var/summary.json']), null, 2));
console.log('实验分析（意向分析，实验单位：展商）');
const experiment = await main(['experiment','--out','var/experiment.json','--report','var/experiment-report.md']);
console.log(JSON.stringify(experiment, null, 2));
console.log('中文结论');
console.log(experiment.conclusion.zh.join('\n'));
console.log('业务配置');
console.log(JSON.stringify(JSON.parse(await readFile('data/policy.json', 'utf8')), null, 2));
console.log(`完成，用时 ${Math.ceil(performance.now() - started)} 毫秒`);
