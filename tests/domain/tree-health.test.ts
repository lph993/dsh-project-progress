/**
 * **树健康检查**的判据（0.3.48）。
 *
 * 用户问过两次"这棵树是否健康"，而我两次都是**临时写脚本**才算出来 ——
 * 那说明判据只在我脑子里。这些测试把判据钉在代码里：
 * **每一条都必须能落到"哪个节点违反了哪条"**，不许出现"我觉得不太好"。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  analyzeTreeHealth,
  summarizeHealth,
  type HealthNode,
  type HealthInput,
} from '../../src/domain/tree-health.ts';

const node = (
  id: string,
  name: string,
  parentId: string | null,
  extra: Partial<HealthNode> = {},
): HealthNode => ({
  id,
  name,
  parentId,
  kind: 'feature',
  refs: [],
  state: 'pending',
  progress: 0,
  selfState: 'pending',
  ...extra,
});

/**
 * 一棵"健康"的基准树：单根=项目本体、3 层、每层不超限、都有 refs 与描述，
 * **进度各不相同**（全一样会触发 `uniform-progress` —— 那本来就该报，真机上"全是 0%"
 * 意味着"没评估"而不是"都没做"）。
 */
const HEALTHY: HealthNode[] = [
  node('r', 'PEIS 体检管理系统', null, { refs: ['README.md'], description: '项目本体', progress: 0.2 }),
  node('a', '体检业务办理', 'r', { refs: ['src/biz'], description: '主业务流程', progress: 0.6 }),
  node('b', '移动与外检', 'r', { refs: ['src/mobile'], description: '移动端', progress: 0.3 }),
  node('a1', '预约与登记', 'a', { refs: ['src/biz/reg'], description: '预约登记', progress: 0.8 }),
  node('a2', '报告出具', 'a', { refs: ['src/biz/report'], description: '报告', progress: 0.1 }),
  node('b1', '外检表单', 'b', { refs: ['src/mobile/form'], description: '表单', progress: 0.45 }),
];

const codesOf = (issues: ReadonlyArray<{ code: string }>): string[] => issues.map((issue) => issue.code);

describe('树健康：整体结论', () => {
  it('基准树没有问题，且 healthy=true', () => {
    const report = analyzeTreeHealth({ projectName: 'PEIS 体检管理系统', nodes: HEALTHY });
    assert.equal(report.healthy, true, `不该有问题：${JSON.stringify(report.issues)}`);
    assert.deepEqual(codesOf(report.issues), []);
    assert.equal(report.stats.roots, 1);
    assert.equal(report.stats.rootChildren, 2);
  });

  it('统计口径对得上（节点/根/最深/根下/叶/refs）', () => {
    const report = analyzeTreeHealth({ projectName: 'PEIS 体检管理系统', nodes: HEALTHY });
    assert.equal(report.stats.alive, 6);
    assert.equal(report.stats.maxDepth, 2);
    assert.equal(report.stats.leaves, 3, '叶 = a1 / a2 / b1 三个');
    assert.equal(report.stats.refsTotal, 6);
    assert.equal(report.stats.nodesWithDescription, 6);
  });

  it('墓碑节点不参与检查（删掉的不该算问题）', () => {
    const withTombstone = [...HEALTHY, node('x', '已删', null, { selfState: 'removed' })];
    const report = analyzeTreeHealth({ projectName: 'PEIS 体检管理系统', nodes: withTombstone });
    assert.equal(report.stats.nodes, 7, '总数含墓碑');
    assert.equal(report.stats.alive, 6, '活着的仍是 6');
    assert.deepEqual(codesOf(report.issues), [], '墓碑不许造成 multi-root');
  });
});

describe('树健康：逐条判据', () => {
  it('根多于 1 个 ⇒ error（单根不变量）', () => {
    const report = analyzeTreeHealth({
      projectName: 'PEIS 体检管理系统',
      nodes: [...HEALTHY, node('r2', 'PEIS 体检信息系统', null, { refs: ['x'] })],
    });
    assert.equal(report.healthy, false);
    assert.ok(codesOf(report.issues).includes('multi-root'));
    assert.match(report.issues.find((i) => i.code === 'multi-root')?.message ?? '', /2 个顶级节点/);
  });

  it('根不是项目本体 ⇒ error（这是层级方向反了的根源）', () => {
    const report = analyzeTreeHealth({
      projectName: 'PEIS 体检管理系统',
      nodes: [
        node('r', 'Web 服务端', null, { refs: ['src/web'], description: '网站' }),
        node('a', '体检登记', 'r', { refs: ['src/web/reg'], description: '登记' }),
      ],
      looksLikeEndpointName: (name) => name.includes('服务端'),
    });
    assert.equal(report.healthy, false);
    const issue = report.issues.find((i) => i.code === 'root-not-project');
    assert.ok(issue, '必须报出根不像项目本体');
    assert.match(issue?.message ?? '', /像某个端\/模块/);
  });

  it('**直接子节点超过 6 个 ⇒ warn**（提示词写了但从来没人校验的那条）', () => {
    const wide: HealthNode[] = [node('r', 'PEIS 体检管理系统', null, { refs: ['a'], description: '本体' })];
    for (let index = 0; index < 9; index += 1) {
      wide.push(node(`c${index}`, `分支${index}`, 'r', { refs: [`d${index}`], description: 'x' }));
    }
    const report = analyzeTreeHealth({ projectName: 'PEIS 体检管理系统', nodes: wide });
    const issue = report.issues.find((i) => i.code === 'too-many-children');
    assert.ok(issue, '必须报出宽度超限');
    assert.match(issue?.message ?? '', /9 个直接子节点（上限 6）/);
    assert.equal(issue?.nodeIds.length, 10, '要能把父节点与子节点都指出来（面板可点过去）');
  });

  it('单子链 ⇒ warn（白占一层）', () => {
    const chain = [
      node('r', 'PEIS 体检管理系统', null, { refs: ['a'], description: '本体' }),
      node('x', '甲', 'r', { refs: ['a/x'], description: 'x' }),
      node('y', '乙', 'x', { refs: ['a/x/y'], description: 'y' }),
      node('z', '丙', 'y', { refs: ['a/x/y/z'], description: 'z' }),
    ];
    const report = analyzeTreeHealth({ projectName: 'PEIS 体检管理系统', nodes: chain });
    assert.ok(codesOf(report.issues).includes('single-child-chain'), '必须报出单子链');
  });

  it('过深 ⇒ warn（真机串链到过 8 层）', () => {
    const deep: HealthNode[] = [node('r', 'PEIS 体检管理系统', null, { refs: ['d0'], description: '本体' })];
    let parent = 'r';
    for (let index = 1; index <= 8; index += 1) {
      const id = `d${index}`;
      deep.push(node(id, `层${index}`, parent, { refs: [`d${index}`], description: 'x' }));
      parent = id;
    }
    const report = analyzeTreeHealth({ projectName: 'PEIS 体检管理系统', nodes: deep });
    assert.ok(codesOf(report.issues).includes('too-deep'), '必须报出过深');
    assert.equal(report.stats.maxDepth, 8);
  });

  it('**节点名就是目录名 ⇒ warn**（§0.0 否决信号 1；真机「PEIS.Web」「Controllers」那种）', () => {
    const dirNamed = [
      node('r', 'PEIS 体检管理系统', null, { refs: ['README.md'], description: '本体' }),
      node('w', 'PEIS.Web', 'r', { refs: ['PEIS.Web'], description: '网站' }),
      node('w1', '体检登记', 'w', { refs: ['PEIS.Web/Controllers/Reg'], description: '登记' }),
      node('w2', '报告打印', 'w', { refs: ['PEIS.Web/Controllers/Print'], description: '打印' }),
    ];
    const report = analyzeTreeHealth({ projectName: 'PEIS 体检管理系统', nodes: dirNamed });
    const issue = report.issues.find((i) => i.code === 'name-is-directory');
    assert.ok(issue, '节点名等于它引用的目录名 ⇒ 必须报出来');
    assert.match(issue?.message ?? '', /目录名/);
    assert.match(issue?.message ?? '', /目录只是好分类/, '要引用用户那条原则，别只说"不规范"');
  });

  it('**合法分组不许被误判**（「体检业务办理」refs 是目录、子节点也在其下 —— 这在结构上一样）', () => {
    /**
     * 我第一版用"只有一条目录 refs + 子节点全在其下 ⇒ 包装层"，结果**把这种正当分组也判成问题**。
     * 光看 refs 分不开"功能分组"与"人为包装层"，所以判据改成了可核对的"名字是不是目录名"。
     */
    const legit = [
      node('r', 'PEIS 体检管理系统', null, { refs: ['README.md'], description: '本体' }),
      node('a', '体检业务办理', 'r', { refs: ['src/biz'], description: '主流程' }),
      node('a1', '预约与登记', 'a', { refs: ['src/biz/reg'], description: '登记' }),
      node('a2', '报告出具', 'a', { refs: ['src/biz/report'], description: '报告' }),
    ];
    const report = analyzeTreeHealth({ projectName: 'PEIS 体检管理系统', nodes: legit });
    assert.ok(
      !codesOf(report.issues).includes('name-is-directory'),
      '功能命名的节点即便 refs 是目录、子节点都在其下，也不许报 —— 那是最常见的正当结构',
    );
  });

  it('refs 指向不存在的路径 ⇒ warn（模型最容易编造的东西）', () => {
    const input: HealthInput = {
      projectName: 'PEIS 体检管理系统',
      nodes: [
        node('r', 'PEIS 体检管理系统', null, { refs: ['README.md'], description: '本体' }),
        node('a', '编造的功能', 'r', { refs: ['不存在的目录/xx.ts'], description: 'x' }),
      ],
      refExists: (target) => !target.includes('不存在'),
    };
    const report = analyzeTreeHealth(input);
    const issue = report.issues.find((i) => i.code === 'refs-missing-target');
    assert.ok(issue, '必须报出指向不存在路径的 refs');
    assert.match(issue?.message ?? '', /不存在的路径/);
  });

  it('身份重复（多个节点引用同一批路径）⇒ warn', () => {
    const dup = [
      node('r', 'PEIS 体检管理系统', null, { refs: ['README.md'], description: '本体' }),
      node('a', '体检业务', 'r', { refs: ['src/biz'], description: 'a' }),
      node('b', '体检业务办理', 'r', { refs: ['src/biz'], description: 'b' }),
    ];
    const report = analyzeTreeHealth({ projectName: 'PEIS 体检管理系统', nodes: dup });
    assert.ok(codesOf(report.issues).includes('duplicate-identity'), '同一批 refs 的两个节点必须报出来');
  });

  it('无 refs / 无描述 / 进度整齐 ⇒ info（不影响 healthy）', () => {
    const report = analyzeTreeHealth({
      projectName: 'PEIS 体检管理系统',
      nodes: [
        node('r', 'PEIS 体检管理系统', null), // 无 refs、无描述
        node('a', '甲', 'r', { progress: 0 }),
        node('b', '乙', 'r', { progress: 0 }),
        node('c', '丙', 'r', { progress: 0 }),
        node('d', '丁', 'r', { progress: 0 }),
      ],
    });
    const codes = codesOf(report.issues);
    assert.ok(codes.includes('no-refs'));
    assert.ok(codes.includes('no-description'));
    assert.ok(codes.includes('uniform-progress'));
    assert.equal(report.healthy, true, 'info 级不影响"健康"这个结论');
  });
});

describe('树健康：一行摘要（面板/建树说明用）', () => {
  it('健康时明确说"没有发现问题"', () => {
    const text = summarizeHealth(analyzeTreeHealth({ projectName: 'PEIS 体检管理系统', nodes: HEALTHY }));
    assert.match(text, /树体检：/);
    assert.match(text, /没有发现问题/);
  });

  it('有问题时报出**前几条**并说明还有几条（不刷屏）', () => {
    const wide: HealthNode[] = [node('r', 'PEIS 体检管理系统', null, { refs: ['a'], description: '本体' })];
    for (let index = 0; index < 9; index += 1) {
      wide.push(node(`c${index}`, `分支${index}`, 'r', { refs: [`d${index}`], description: 'x' }));
    }
    const wide2 = [...wide, node('r2', 'Web 服务端', null, { refs: ['b'], description: 'x' })];
    const text = summarizeHealth(analyzeTreeHealth({ projectName: 'PEIS 体检管理系统', nodes: wide2 }));
    assert.match(text, /项要处理/);
    assert.match(text, /另 \d+ 项/);
  });
});

describe('树健康：no-refs 不许误报"聚合节点"（0.3.51 真机）', () => {
  it('功能组自身没 refs、但子节点有 ⇒ **不报**', () => {
    /**
     * 真机现场：`regroupShardedBranches` 建出来的 6 个功能组自身没有 refs
     * （它描述的是"这组功能"，不是某段代码），而它们的子节点合计 121 条。
     * 旧判据只看"自己有没有 refs" ⇒ 6 个组全被误报成"无法核对它覆盖哪块代码"。
     */
    const withGroup = [
      node('r', 'PEIS 体检信息系统', null, { refs: ['README.md'], description: '本体', progress: 0.3 }),
      node('g', '体检业务办理与检查', 'r', { description: '一组功能（聚合节点）', progress: 0.5 }),
      node('g1', '体检登记', 'g', { refs: ['src/reg'], description: '登记', progress: 0.6 }),
      node('g2', '总检结论', 'g', { refs: ['src/sum'], description: '总检', progress: 0.4 }),
    ];
    const report = analyzeTreeHealth({ projectName: 'PEIS 体检信息系统', nodes: withGroup });
    assert.ok(
      !codesOf(report.issues).includes('no-refs'),
      `聚合节点自身 refs 为空是正常的，不许报：${JSON.stringify(report.issues)}`,
    );
  });

  it('整棵子树都没有 refs ⇒ **要报**（这才是"无法核对"）', () => {
    const empty = [
      node('r', 'PEIS 体检信息系统', null, { refs: ['README.md'], description: '本体', progress: 0.3 }),
      node('x', '悬空的组', 'r', { description: '没有任何依据', progress: 0.5 }),
      node('x1', '悬空的子项', 'x', { description: '也没有', progress: 0.4 }),
    ];
    const report = analyzeTreeHealth({ projectName: 'PEIS 体检信息系统', nodes: empty });
    const issue = report.issues.find((i) => i.code === 'no-refs');
    assert.ok(issue, '整棵子树都空 ⇒ 必须报出来');
    /** 该报的是"整棵子树都空"的那一支；**不许**把有 refs 的聚合节点（功能组那种）算进来。 */
    assert.ok(issue?.nodeIds.includes('x'), '整棵子树都空的那一支必须被报出来');
    assert.ok(!issue?.nodeIds.includes('r'), '根自己有 refs，不该被报');
  });
});

describe('树健康：refs 太宽（0.3.52 审 PEIS 树发现）', () => {
  it('平级的节点把别人的范围整个包进去 ⇒ warn（真机「体检业务服务」案例）', () => {
    /**
     * 真机现场：「体检业务服务」的 refs = `PEIS.Web, PEIS.WebApi, PEIS.Service, TimerServer…`
     * 而 **`PEIS.Web` 是整个 Web 工程** —— 它一条 refs 覆盖了另外 26 个节点。
     */
    const nodes = [
      node('r', 'PEIS 体检信息系统', null, { refs: ['README.md'], description: '本体', progress: 0.3 }),
      node('g1', '体检业务办理', 'r', { description: '业务', progress: 0.6 }),
      node('g2', '技术底座', 'r', { description: '底座', progress: 0.5 }),
      node('a', '体检登记', 'g1', { refs: ['PEIS.Web/Areas/CheckUpManage'], description: '登记', progress: 0.7 }),
      /** 太宽：指整个 PEIS.Web，把 g1 那一支的范围也包了进去。 */
      node('b', '体检业务服务', 'g2', { refs: ['PEIS.Web', 'PEIS.Service'], description: '服务宿主', progress: 0.6 }),
    ];
    const report = analyzeTreeHealth({ projectName: 'PEIS 体检信息系统', nodes });
    const issue = report.issues.find((i) => i.code === 'refs-too-broad');
    assert.ok(issue, `必须报出"refs 太宽"：${JSON.stringify(report.issues)}`);
    assert.match(issue?.message ?? '', /包了进去/);
    assert.ok(issue?.nodeIds.includes('b'), '要指出是哪个节点太宽');
  });

  it('**父子之间的重叠不算**（父描述整块、子描述其中一部分，这是正常的）', () => {
    const nodes = [
      node('r', 'PEIS 体检信息系统', null, { refs: ['README.md'], description: '本体', progress: 0.3 }),
      node('a', '体检业务办理', 'r', { refs: ['PEIS.Web/Areas'], description: '业务', progress: 0.5 }),
      node('a1', '体检登记', 'a', { refs: ['PEIS.Web/Areas/CheckUpManage'], description: '登记', progress: 0.7 }),
    ];
    const report = analyzeTreeHealth({ projectName: 'PEIS 体检信息系统', nodes });
    assert.ok(
      !codesOf(report.issues).includes('refs-too-broad'),
      `父子关系的粗细重叠是正常的，不许报：${JSON.stringify(report.issues)}`,
    );
  });
});

describe('树健康：覆盖缺口（0.3.52）', () => {
  it('仓库顶层目录一条 refs 都没提到 ⇒ warn', () => {
    const nodes = [
      node('r', 'PEIS 体检信息系统', null, { refs: ['PEIS.Web'], description: '本体', progress: 0.3 }),
      node('a', '体检业务办理', 'r', { refs: ['PEIS.Web/Areas'], description: '业务', progress: 0.6 }),
    ];
    const report = analyzeTreeHealth({
      projectName: 'PEIS 体检信息系统',
      nodes,
      /** 调用方已排除产物目录，所以这里只列真实源码目录。 */
      knownTopDirs: ['PEIS.Web', 'Mobile', 'PEIS.DataBase'],
    });
    const issue = report.issues.find((i) => i.code === 'coverage-gap');
    assert.ok(issue, '必须报出覆盖缺口');
    assert.match(issue?.message ?? '', /2\/3 个顶层目录/);
    assert.ok(issue?.message.includes('Mobile'), '要点名缺了哪些');
  });

  it('全都有覆盖 ⇒ 不报', () => {
    const nodes = [
      node('r', 'PEIS 体检信息系统', null, { refs: ['PEIS.Web', 'Mobile/app'], description: '本体', progress: 0.3 }),
      node('a', '移动端', 'r', { refs: ['Mobile'], description: '移动端', progress: 0.5 }),
    ];
    const report = analyzeTreeHealth({
      projectName: 'PEIS 体检信息系统',
      nodes,
      knownTopDirs: ['PEIS.Web', 'Mobile'],
    });
    assert.ok(!codesOf(report.issues).includes('coverage-gap'));
  });

  it('不传 knownTopDirs ⇒ 不做这项检查（拿不到仓库时宁可不说）', () => {
    const report = analyzeTreeHealth({
      projectName: 'PEIS 体检信息系统',
      nodes: [node('r', 'PEIS 体检信息系统', null, { refs: ['a'], description: 'x', progress: 0.3 })],
    });
    assert.ok(!codesOf(report.issues).includes('coverage-gap'));
  });
});
