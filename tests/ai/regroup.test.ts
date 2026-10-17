/**
 * **跨片按功能归拢**的判据（0.3.46）。
 *
 * 用户原则（`docs/开发须知.md` §0.0）："不能按目录…切分单位 ≠ 树的分支单位，合并时必须按功能归拢。"
 *
 * 这些测试钉住的是**五条硬约束**，因为方案一旦应用就会真的搬动节点：
 * 少校验一条，模型的一句幻觉就能把树改成谁都看不懂的样子。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AI_REGROUP_SYSTEM_PROMPT,
  MAX_REGROUP_GROUPS,
  buildRegroupPrompt,
  parseRegroupPlan,
  validateRegroupPlan,
  type RegroupBranch,
  type RegroupGroup,
} from '../../src/ai/regroup.ts';

const branch = (id: string, name: string, childCount = 3): RegroupBranch => ({
  id,
  name,
  refs: [`${name}/src`],
  childCount,
});

const BRANCHES: RegroupBranch[] = [
  branch('a', 'PEIS.Web'),
  branch('b', 'Modules/PEIS.Occ'),
  branch('c', 'Mobile'),
  branch('d', 'PEIS.DataBase'),
  branch('e', 'PEIS.FormsOut'),
  branch('f', 'BlazorLayui'),
];

describe('归拢：解析模型输出', () => {
  it('从代码围栏/前后废话里抠出 JSON', () => {
    const text = '这里是结果：\n```json\n{"groups":[{"name":"甲","branchIds":["a","b"]},{"name":"乙","branchIds":["c","d"]}]}\n```\n完。';
    const parsed = parseRegroupPlan(text);
    assert.equal(parsed.groups.length, 2);
    assert.deepEqual(parsed.groups[0]?.branchIds, ['a', 'b']);
  });

  it('不是 JSON ⇒ 明确记为 rejected（不许当成"没问题"）', () => {
    const parsed = parseRegroupPlan('我觉得这棵树挺好的');
    assert.equal(parsed.groups.length, 0);
    assert.match(parsed.rejected.join(''), /不是可解析的 JSON/);
  });

  it('缺 name / 空 branchIds 的组被丢弃并记账', () => {
    const text = JSON.stringify({
      groups: [
        { name: '', branchIds: ['a', 'b'] },
        { name: '乙', branchIds: [] },
        { name: '丙', branchIds: ['c', 'd'] },
      ],
    });
    const parsed = parseRegroupPlan(text);
    assert.equal(parsed.groups.length, 1, '只有合法的组留下');
    assert.equal(parsed.rejected.length, 2);
  });
});

describe('归拢：五条硬约束（任一条不满足 ⇒ 整份作废）', () => {
  const ok: RegroupGroup[] = [
    { name: '体检业务办理', branchIds: ['b', 'a'] },
    { name: '移动与外检客户端', branchIds: ['c', 'e'] },
    { name: '基础技术底座', branchIds: ['d', 'f'] },
  ];

  it('合法方案通过，并如实报出"没被归拢的分支保持原位"', () => {
    const result = validateRegroupPlan(ok, BRANCHES, 'PEIS 体检管理系统');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.plan.groups.length, 3);
  });

  it('约束 1：一个分支被分进两个组 ⇒ 作废', () => {
    const result = validateRegroupPlan(
      [
        { name: '甲', branchIds: ['a', 'b'] },
        { name: '乙', branchIds: ['b', 'c'] },
      ],
      BRANCHES,
      'X 项目',
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /同时被分进/);
  });

  it('约束 1：编造的分支 id ⇒ 作废', () => {
    const result = validateRegroupPlan(
      [
        { name: '甲', branchIds: ['a', '不存在的id'] },
        { name: '乙', branchIds: ['c', 'd'] },
      ],
      BRANCHES,
      'X 项目',
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /不在待归拢列表/);
  });

  it('约束 1（另一半）：漏掉的分支**保持原位**，不算失败', () => {
    const result = validateRegroupPlan(
      [
        { name: '甲', branchIds: ['a', 'b'] },
        { name: '乙', branchIds: ['c', 'd'] },
      ],
      BRANCHES,
      'X 项目',
    );
    assert.equal(result.ok, true, '漏掉不该让整份作废（那会白烧一次调用）');
    if (result.ok) {
      assert.equal(result.plan.groups.length, 2);
      const used = new Set(result.plan.groups.flatMap((g) => g.branchIds));
      assert.equal(used.has('e'), false, '漏掉的 e 不该被塞进任何组');
    }
  });

  it('约束 2：只有 1 组 ⇒ 作废（等于没归拢）', () => {
    const result = validateRegroupPlan([{ name: '甲', branchIds: ['a', 'b'] }], BRANCHES, 'X 项目');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /至少 2 组/);
  });

  it('约束 2：组数超过上限 ⇒ 作废', () => {
    const many: RegroupGroup[] = Array.from({ length: MAX_REGROUP_GROUPS + 1 }, (_, i) => ({
      name: `组${i}`,
      branchIds: ['a', 'b'],
    }));
    const result = validateRegroupPlan(many, BRANCHES, 'X 项目');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /最多/);
  });

  it('约束 3：某组只有 1 个分支 ⇒ 作废（白加一层包装，正是用户要消掉的）', () => {
    const result = validateRegroupPlan(
      [
        { name: '甲', branchIds: ['a', 'b'] },
        { name: '乙', branchIds: ['c'] },
      ],
      BRANCHES,
      'X 项目',
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /至少 2 个|每组建至少要 2 个/);
  });

  it('约束 4：组名与项目名同源 ⇒ 作废（项目名只该是根）', () => {
    const result = validateRegroupPlan(
      [
        { name: 'PEIS 体检管理系统', branchIds: ['a', 'b'] },
        { name: '基础底座', branchIds: ['c', 'd'] },
      ],
      BRANCHES,
      'PEIS 体检管理系统',
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /项目名只该是根/);
  });

  it('约束 5：两个组同名 ⇒ 作废', () => {
    const result = validateRegroupPlan(
      [
        { name: '基础底座', branchIds: ['a', 'b'] },
        { name: '基础底座', branchIds: ['c', 'd'] },
      ],
      BRANCHES,
      'X 项目',
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /重复出现/);
  });
});

describe('归拢：提示词必须把"按功能不按目录"讲清楚', () => {
  it('系统提示词要求按功能分组、点名禁用目录名/技术分层名', () => {
    assert.match(AI_REGROUP_SYSTEM_PROMPT, /按功能分/);
    assert.match(AI_REGROUP_SYSTEM_PROMPT, /PEIS\.Web/);
    assert.match(AI_REGROUP_SYSTEM_PROMPT, /Common/);
  });

  it('用户消息逐个列出分支与 id（模型才能引用）', () => {
    const text = buildRegroupPrompt({ projectName: 'X 项目', branches: BRANCHES });
    for (const b of BRANCHES) {
      assert.ok(text.includes(`id=${b.id}`), `必须给出「${b.name}」的 id`);
      assert.ok(text.includes(b.name), `必须给出「${b.name}」的名字`);
    }
    assert.match(text, /一处不漏、一处不重/);
  });
});
