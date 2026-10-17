/**
 * **建树前根整形**（0.3.41）。
 *
 * 这是"事后修不了 ⇒ 改在落库前"的那条路。判据必须**可核对、不看仓库名**，
 * 并且**只在真的发生层级倒置时**动手（歧义一律不动）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reshapeRootToProjectBody } from '../../src/ai/root-reshape.ts';
import type { AiTree } from '../../src/ai/parse.ts';

const node = (name: string, parent: number | null) => ({ name, kind: 'feature' as const, parent, refs: [] });
const names = (tree: AiTree) => tree.nodes.map((n) => n.name);

/** 把 AiTree 还原成"名字 → 父名字"的层级，便于断言。 */
function levels(tree: AiTree): string[] {
  return tree.nodes.map((n) => {
    const parent = n.parent === null ? '(根)' : (tree.nodes[n.parent]?.name ?? '?');
    return `${parent} > ${n.name}`;
  });
}

describe('建树前根整形：让项目本体当根', () => {
  it('真机现场：根是端、项目本体是它的子节点 ⇒ 扶正（内容零丢失）', () => {
    const tree: AiTree = {
      projectName: 'PEIS 体检管理系统',
      nodes: [
        node('Web 服务端', null), // 0 旧根
        node('前端界面框架', 0), // 1 旧根的子
        node('报表输出', 0), // 2 旧根的子
        node('PEIS 体检管理系统', 0), // 3 项目本体（是枝，也有自己的子）
        node('体检业务办理', 3), // 4 项目本体的子
        node('移动端', 3), // 5 项目本体的子
      ],
    };
    const out = reshapeRootToProjectBody(tree, tree.projectName ?? '');
    assert.equal(out.reshaped, true, '发生了层级倒置就必须扶正');
    assert.equal(out.tree.nodes[0]?.name, 'PEIS 体检管理系统', '**项目本体必须当根**');
    assert.equal(out.tree.nodes[0]?.parent, null, '根必须是 parent === null');
    assert.equal(out.tree.nodes.length, 6, '**节点一个都不许丢**');
    assert.equal(new Set(names(out.tree)).size, 6, '名字不许丢也不许重复');

    const lv = levels(out.tree);
    assert.ok(lv.includes('(根) > PEIS 体检管理系统'), '项目本体当根');
    assert.ok(lv.includes('PEIS 体检管理系统 > Web 服务端'), '**旧根降为项目本体的子节点**');
    assert.ok(
      lv.includes('Web 服务端 > 前端界面框架'),
      '旧根的其余子节点**跟随它们的父**（挂到旧根下面）—— 这样层级不乱、也不与旧根平级',
    );
    assert.ok(lv.includes('Web 服务端 > 报表输出'), '旧根的其余子节点跟随旧根');
    assert.ok(lv.includes('PEIS 体检管理系统 > 体检业务办理'), '项目本体原有的子节点保持不动');
    assert.ok(lv.includes('PEIS 体检管理系统 > 移动端'), '项目本体原有的子节点保持不动');

    /** 根有且只有一个。 */
    assert.equal(out.tree.nodes.filter((n) => n.parent === null).length, 1, '**单项根不变量**：只能一个根');
    /** 所有 parent 下标都必须有效（重排最容易在这里写错）。 */
    for (const n of out.tree.nodes) {
      if (n.parent !== null) assert.ok(n.parent >= 0 && n.parent < out.tree.nodes.length, `parent 下标越界：${n.parent}`);
    }
    assert.match(out.note ?? '', /根节点整形/, '必须留下"整形过"的说明（否则用户不知道树被动过）');
  });

  it('根自己就是项目本体 ⇒ 不动（命名不同不算错）', () => {
    const tree: AiTree = {
      projectName: 'PEIS 体检管理系统',
      nodes: [node('PEIS 体检信息系统', null), node('Web 服务端', 0), node('体检业务办理', 0)],
    };
    const out = reshapeRootToProjectBody(tree, tree.projectName ?? '');
    assert.equal(out.reshaped, false, '根已经是项目本体（只是自称不同），不该动');
    assert.deepEqual(names(out.tree), ['PEIS 体检信息系统', 'Web 服务端', '体检业务办理']);
  });

  it('顶级不止一个（历史遗留形状）⇒ 不动（"该挂谁"没有唯一答案）', () => {
    const tree: AiTree = {
      projectName: 'PEIS 体检管理系统',
      nodes: [node('Web 服务端', null), node('移动端', null), node('PEIS 体检管理系统', 0)],
    };
    const out = reshapeRootToProjectBody(tree, tree.projectName ?? '');
    assert.equal(out.reshaped, false, '顶级不是恰好一个时任何排序都是猜 —— 宁可不动');
  });

  it('两个候选同样像项目名 ⇒ 不动（并列分不出本体）', () => {
    const tree: AiTree = {
      projectName: 'PEIS 体检管理系统',
      nodes: [
        node('Web 服务端', null),
        node('PEIS 体检管理系统', 0),
        node('PEIS 体检管理系统移动端', 0),
      ],
    };
    const out = reshapeRootToProjectBody(tree, tree.projectName ?? '');
    assert.equal(out.reshaped, false, '并列最像时必须不动（猜错比不动更糟）');
  });

  it('旧根的子节点里没有像项目名的 ⇒ 不动', () => {
    const tree: AiTree = {
      projectName: 'PEIS 体检管理系统',
      nodes: [node('Web 服务端', null), node('报表输出', 0), node('权限', 0)],
    };
    const out = reshapeRootToProjectBody(tree, tree.projectName ?? '');
    assert.equal(out.reshaped, false);
  });

  it('根的子节点没一个像项目名（正常形状）⇒ 不动', () => {
    const tree: AiTree = {
      projectName: 'PEIS 体检管理系统',
      nodes: [node('Web 服务端', null), node('前端界面框架', 0), node('报表输出', 0)],
    };
    const out = reshapeRootToProjectBody(tree, tree.projectName ?? '');
    assert.equal(out.reshaped, false);
  });

  it('项目名核心串过短 ⇒ 不判（挡住"含一个泛词就命中"）', () => {
    const tree: AiTree = {
      projectName: '系统',
      nodes: [node('Web 服务端', null), node('系统管理', 0)],
    };
    const out = reshapeRootToProjectBody(tree, tree.projectName ?? '');
    assert.equal(out.reshaped, false);
  });

  it('候选与旧根同名 ⇒ 不动（无判据可区分）', () => {
    const tree: AiTree = {
      projectName: 'PEIS 体检管理系统',
      nodes: [node('PEIS 体检管理系统', null), node('PEIS 体检管理系统', 0)],
    };
    const out = reshapeRootToProjectBody(tree, tree.projectName ?? '');
    assert.equal(out.reshaped, false, '同名时"哪个是本体"分不出来');
  });

  it('深层节点一律保持原有父子关系（只动顶级那两个）', () => {
    const tree: AiTree = {
      projectName: 'PEIS 体检管理系统',
      nodes: [
        node('Web 服务端', null),
        node('前端界面框架', 0),
        node('登录页', 1),
        node('PEIS 体检管理系统', 0),
        node('体检业务办理', 3),
        node('预约管理', 4),
      ],
    };
    const out = reshapeRootToProjectBody(tree, tree.projectName ?? '');
    const lv = levels(out.tree);
    assert.ok(lv.includes('前端界面框架 > 登录页'), '旧根的孙节点关系不许变');
    assert.ok(lv.includes('体检业务办理 > 预约管理'), '项目本体的孙节点关系不许变');
  });
});
