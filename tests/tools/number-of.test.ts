/**
 * 数字参数的**宽容转换**（0.3.18）。
 *
 * ## 为什么值得单测
 *
 * 真机事故取证：一次工具调用的参数被拆成 531 个流式片断，拼出来的 JSON 里
 * `"progress": "0.3"` —— **数字被写成带引号的字符串**，整串 JSON 因此非法，
 * 宿主以 `MALFORMED_RESPONSE` **中断整个回合**（那一轮工作全丢）。
 *
 * 这一类的形态在插件侧是可以兜住的：schema 声明 number，而 `"0.3"` 语义上就是 0.3。
 * 但**边界必须钉住**——宽容不许退化成"什么都收"，否则会把"模型给错了"变成"插件悄悄改数"。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * ⚠️ **用真实现，不再复刻**（0.3.27，独立审查指出的隐患）。
 *
 * 原先这里在测试文件里**重新定义了一份**同名函数（因为真实现没导出）。
 * 两份当时逐字一致，但**任何一边漂移都不会被发现** —— 那条防线实际上不设防，
 * 测试永远绿。现在 import 真实现：改坏了这里就会红。
 */
import { numberOf } from '../../src/tools/index.ts';

describe('numberOf：宽容读数字的边界', () => {
  it('**字符串数字要收**（真机事故就是它导致的整轮中断）', () => {
    assert.equal(numberOf('0.3'), 0.3, 'progress: "0.3" 必须读成 0.3');
    assert.equal(numberOf('1'), 1);
    assert.equal(numberOf(' 0.85 '), 0.85, '两侧空白要容忍');
    assert.equal(numberOf('-2'), -2);
    assert.equal(numberOf('0'), 0, '0 是合法值，不能因为 falsy 被当成"没给"');
  });

  it('数字原样通过（含负数与小数）', () => {
    assert.equal(numberOf(0.35), 0.35);
    assert.equal(numberOf(0), 0);
    assert.equal(numberOf(-1.5), -1.5);
  });

  it('**读不成数的一律 undefined**（不许猜）', () => {
    assert.equal(numberOf(''), undefined);
    assert.equal(numberOf('   '), undefined);
    assert.equal(numberOf('跑了一半'), undefined);
    assert.equal(numberOf('0.3 左右'), undefined);
    assert.equal(numberOf('NaN'), undefined, 'Number("NaN") 是 NaN ⇒ 不收');
    assert.equal(numberOf('Infinity'), undefined);
    assert.equal(numberOf(NaN), undefined);
    assert.equal(numberOf(Infinity), undefined);
    assert.equal(numberOf(-Infinity), undefined);
  });

  it('非数字/非字符串类型一律 undefined（不替模型做类型体操）', () => {
    assert.equal(numberOf(undefined), undefined);
    assert.equal(numberOf(null), undefined);
    assert.equal(numberOf(true), undefined);
    assert.equal(numberOf({}), undefined);
    assert.equal(numberOf([]), undefined);
    assert.equal(numberOf([1]), undefined, '数组不该被 Number() 悄悄读成 1');
  });

  it('十六进制/科学计数这类"能读成数"的串：语义上仍是数，收下但不静默变义', () => {
    // 这两条是**记录现状**而非鼓励：`Number` 认它们，插件就按数收；
    // 真要收紧的话，应该在这里加白名单，而不是让调用方各自判断。
    assert.equal(numberOf('1e-3'), 0.001);
    assert.equal(numberOf('0x10'), 16);
  });
});
