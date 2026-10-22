import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_REFS_PER_NODE, parseTreeResponse } from '../../src/ai/parse.ts';

test('refs 超上限必须**留痕**，不许静默截断（0.3.62）', () => {
  /**
   * 原来这里是链式 `.slice(0, MAX_REFS_PER_NODE)` —— 多出来的直接消失，
   * 与本项目自己定的要求（"每个上限都要留痕；丢弃本身可以，静默丢弃不行"）冲突。
   * 引用被砍掉却不说，用户会以为"这个节点只覆盖这些代码"。
   */
  const many = Array.from({ length: MAX_REFS_PER_NODE + 5 }, (_v, i) => ({
    type: 'dir',
    target: `d${i}`,
  }));
  const outcome = parseTreeResponse(JSON.stringify({ projectName: 'X', nodes: [{ name: '节点', parent: null, refs: many }] }));
  assert.equal(outcome.ok, true);
  const refs = outcome.ok ? outcome.value.nodes[0]?.refs ?? [] : [];
  assert.equal(refs.length, MAX_REFS_PER_NODE, '个数仍按上限截断');
  assert.match(
    (outcome.ok ? outcome.notes : []).join('\n'),
    /超过单节点上限/,
    '**截断必须说出来**（这条就是本版修的东西）',
  );
});

test('refs 没超上限时不许冒出"截断"提示（防噪声）', () => {
  const outcome = parseTreeResponse(
    JSON.stringify({ projectName: 'X', nodes: [{ name: '节点', parent: null, refs: [{ type: 'dir', target: 'a' }] }] }),
  );
  assert.equal(outcome.ok, true);
  assert.doesNotMatch((outcome.ok ? outcome.notes : []).join('\n'), /超过单节点上限/);
});