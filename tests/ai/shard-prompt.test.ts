/**
 * **分批建树时必须告诉模型"你只看得到这一片"**（0.3.45 真机病灶）。
 *
 * ## 现场
 *
 * PEIS：`SHARD_MAX_COUNT = 6` 时，合并片吞下 **20 个互不相关的顶层目录**，
 * 提示词又**完全没提"这是分批"** —— 模型以为那就是整个仓库，只能把这 20 个目录
 * 组织成一棵树，于是**串成了一条 8 层深的链**：
 *
 * ```
 * 职业健康业务模块 > 职业健康咨询与资料上传 > … > 客户端资源与启动加载
 *   > 数据访问与仓储层 > 领域模型与业务事件 > Blazor 组件库与适配站点
 * ```
 *
 * 跨度从"职业健康"到"Blazor 组件库"：移动端、外检客户端、基础库、Blazor 全被串进同一分支。
 *
 * 这条测试钉住渲染出来的提示词里**必须有**"你只看到一部分""应该并列、不许串成链"。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderSkeleton } from '../../src/ai/prompt.ts';

const skeleton = [{ path: 'Modules', kind: 'dir', fileCount: 3 } as never];

describe('分批提示词：必须交代"只看得到这一片"', () => {
  it('多片且片内有多个目录 ⇒ 明说"第 i/N 片、你只看到一部分"', () => {
    const text = renderSkeleton({
      projectName: 'PEIS 体检管理系统',
      skeleton,
      maxNodes: 20,
      shardScope: {
        index: 2,
        total: 6,
        label: 'Modules 等 5 个目录',
        groups: ['Modules', 'Mobile', 'PEIS.DataBase', 'PEIS.FormsOut', 'BlazorLayui'],
      },
    });
    assert.match(text, /第 2\/6 片/, '必须说清是第几片/共几片');
    assert.match(text, /只看到仓库的一部分/, '必须说清"只是一部分"，否则模型以为自己在看整个仓库');
  });

  it('片内有多个目录 ⇒ 明说"互不相关、并列、不许串成链"', () => {
    const text = renderSkeleton({
      projectName: 'PEIS 体检管理系统',
      skeleton,
      maxNodes: 20,
      shardScope: {
        index: 2,
        total: 6,
        label: 'Modules 等 5 个目录',
        groups: ['Modules', 'Mobile', 'PEIS.DataBase'],
      },
    });
    assert.match(text, /互不相关/, '这是判断模型行为的核心线索');
    assert.match(text, /并列的大功能\/分支/, '要给出"该做什么"而不只是"别做什么"');
    assert.match(text, /绝不许把它们串成一条链/, '真机病灶就是串链，必须点名禁止');
    /** 名单要逐个列出来，模型才知道具体是哪几块。 */
    for (const group of ['Modules', 'Mobile', 'PEIS.DataBase']) {
      assert.ok(text.includes(group), `片内目录「${group}」必须列给模型看`);
    }
  });

  it('明说"所有片共用一个根，别另起叫项目名的子节点"', () => {
    const text = renderSkeleton({
      projectName: 'PEIS 体检管理系统',
      skeleton,
      maxNodes: 20,
      shardScope: { index: 1, total: 6, label: 'Modules', groups: ['Modules'] },
    });
    assert.match(text, /共用一个根/, '否则每片各起一个根/子根，合并后又是层层嵌套');
    assert.match(text, /另起一个叫项目名的子节点/, '这条正是 0.3.33 踩过的坑，分批时更容易犯');
  });

  it('只有一片时不加这段（单次建树不该说"分批"）', () => {
    const text = renderSkeleton({ projectName: 'X', skeleton, maxNodes: 10, shardScope: { index: 1, total: 1, label: '', groups: [] } });
    assert.ok(!text.includes('分批建树'), '单片时不许提分批');
  });

  it('不传 shardScope 时行为与从前一致（单次路径不受影响）', () => {
    const text = renderSkeleton({ projectName: 'X', skeleton, maxNodes: 10 });
    assert.ok(!text.includes('分批建树'), '单次路径不该出现分批话术');
    assert.match(text, /项目名建议：X/, '原有内容照旧');
  });
});
