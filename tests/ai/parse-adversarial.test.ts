/**
 * **对抗性输入**（0.3.60）：坏输出不许变成坏树。
 *
 * 这里测的是"模型/仓库内容不受信"时的行为：规模上限、名字净化、refs 净化、终止原因分类。
 * 每条都要求**丢弃可见**（进 notes），不允许静默。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_NAME_LENGTH,
  MAX_NODES_PER_RESPONSE,
  classifyFinish,
  parseTreeResponse,
} from '../../src/ai/parse.ts';

const wrap = (nodes: unknown[]) => JSON.stringify({ projectName: 'X', nodes });

describe('对抗：规模上限', () => {
  it(`超过 ${MAX_NODES_PER_RESPONSE} 个节点 ⇒ 只取前 N 个并说明`, () => {
    const nodes = Array.from({ length: MAX_NODES_PER_RESPONSE + 25 }, (_v, i) => ({
      name: `节点${i}`,
      kind: 'feature',
      parent: i === 0 ? null : 0,
    }));
    const outcome = parseTreeResponse(wrap(nodes));
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok && outcome.value.nodes.length, MAX_NODES_PER_RESPONSE);
    assert.match(
      (outcome.ok ? outcome.notes : []).join('\n'),
      /超过单次上限/,
      '**丢了多少必须说出来**（静默丢弃比丢本身更糟）',
    );
  });

  it(`名字超 ${MAX_NAME_LENGTH} 字 ⇒ 截断并说明`, () => {
    const outcome = parseTreeResponse(wrap([{ name: '名'.repeat(MAX_NAME_LENGTH + 40), parent: null }]));
    assert.equal(outcome.ok, true);
    const node = outcome.ok ? outcome.value.nodes[0] : undefined;
    assert.equal(node?.name.length, MAX_NAME_LENGTH);
    assert.match((outcome.ok ? outcome.notes : []).join('\n'), /名字超过/);
  });

  it('名字里的控制字符会被压平（否则会破坏提示词缩进与文档投影）', () => {
    const outcome = parseTreeResponse(wrap([{ name: '前\t端\n界面\u0000框架', parent: null }]));
    assert.equal(outcome.ok, true);
    const name = outcome.ok ? outcome.value.nodes[0]?.name : '';
    assert.equal(name, '前 端 界面 框架', `控制字符必须压成空格并折叠（实际：${JSON.stringify(name)}）`);
  });
});

describe('对抗：refs 净化', () => {
  it('绝对路径 / 向上逃逸 / 超长路径都被丢掉（只丢这一条，不丢节点）', () => {
    const outcome = parseTreeResponse(
      wrap([
        {
          name: '节点',
          parent: null,
          refs: [
            { type: 'dir', target: '/etc/passwd' },
            { type: 'dir', target: '../../secrets' },
            { type: 'dir', target: 'C:/Windows' },
            { type: 'dir', target: `a/${'x'.repeat(500)}` },
            { type: 'dir', target: 'src/ok.ts' },
          ],
        },
      ]),
    );
    assert.equal(outcome.ok, true);
    const refs = (outcome.ok ? outcome.value.nodes[0]?.refs : []) ?? [];
    assert.deepEqual(
      refs.map((ref) => ref.target),
      ['src/ok.ts'],
      `只有合法的那条能留下（实际：${JSON.stringify(refs)}）`,
    );
    assert.ok((outcome.ok ? outcome.notes : []).length >= 3, '每一条被丢的都要留痕');
  });

  it('单节点 refs 数量上限（防一次输出灌爆存储）', () => {
    const many = Array.from({ length: 40 }, (_v, i) => ({ type: 'dir', target: `d${i}` }));
    const outcome = parseTreeResponse(wrap([{ name: '节点', parent: null, refs: many }]));
    assert.equal(outcome.ok, true);
    const refs = (outcome.ok ? outcome.value.nodes[0]?.refs : []) ?? [];
    assert.equal(refs.length, 12, '超出上限的部分丢弃（上限与旧行为一致：12）');
  });
});

describe('对抗：终止原因分类（取消/报错不许被伪装成"截断"）', () => {
  it('取消 / 报错 / 撞上限 各自归类', () => {
    assert.equal(classifyFinish('aborted'), 'aborted');
    assert.equal(classifyFinish('cancelled'), 'aborted');
    assert.equal(classifyFinish('error'), 'error');
    assert.equal(classifyFinish('max-tokens'), 'limit');
    assert.equal(classifyFinish('length'), 'limit');
    assert.equal(classifyFinish('stop'), 'normal');
    assert.equal(classifyFinish(undefined), 'unknown');
  });
});
