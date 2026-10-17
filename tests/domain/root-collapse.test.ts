/**
 * **事后收拢根**（0.3.41）—— 我 0.3.40 说的"做不到"是错的。
 *
 * ## 错在哪
 *
 * 我只试了搬**非根**节点：提根被 `C13：项目根唯一` 挡、把父挂到子下被 `E_CYCLE` 挡。
 * 于是断言"事后归位做不到"。**但 `mergeRoots()` 一直在用另一条路**：
 * 把**根**挂到另一个**根**下面 —— 成环检查"从新父往上走会不会走到自己"，
 * 而被搬的是根 ⇒ 祖先只有它自己 ⇒ **永不成环**；根数 2 → 1 ⇒ **不触发 C13**。
 *
 * 这条测试把那个判据钉住（**纯函数**，不看仓库、不看技术栈）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideRootCollapse } from '../../src/domain/root-collapse.ts';

const r = (id: string, name: string) => ({ id, name });

describe('事后收拢根：判断该把哪个根降级', () => {
  it('真机形状：一个根叫「Web 服务端」、另一个是本项目 ⇒ 降级"端"、扶"本体"', () => {
    const d = decideRootCollapse(
      [r('web', 'Web 服务端'), r('body', 'PEIS 体检管理系统')],
      'PEIS 体检管理系统',
    );
    assert.ok(d, '两个根、其中一个是项目本体 ⇒ 必须给出决定');
    assert.equal(d.bodyId, 'body', '项目本体要当根');
    assert.equal(d.demoteId, 'web', '"某个端"要降级');
    assert.match(d.reason, /项目本体/);
  });

  it('本体与项目名只共享前缀（真机自称不同）也要认得出来', () => {
    // 真机：项目名「PEIS 体检管理系统」，节点却叫「PEIS 体检信息系统」（共享 8 字符）
    const d = decideRootCollapse([r('web', 'Web 服务端'), r('b', 'PEIS 体检信息系统')], 'PEIS 体检管理系统');
    assert.ok(d, '共享 8 个字符足够认出本体');
    assert.equal(d.bodyId, 'b');
  });

  it('本体已经是根 ⇒ 不动（命名不完全一致不算错）', () => {
    const d = decideRootCollapse([r('a', 'PEIS 体检管理系统'), r('b', '数据库层')], 'PEIS 体检管理系统');
    assert.ok(d, '判据只看"哪个更像"，降级方向由它决定');
    assert.equal(d.bodyId, 'a', '已经是最像的那个当根');
    assert.equal(d.demoteId, 'b');
  });

  it('顶级节点不是恰好 2 个 ⇒ 不动（多根时"该挂谁"没有唯一答案）', () => {
    assert.equal(decideRootCollapse([r('a', 'Web 服务端')], 'PEIS 体检管理系统'), null);
    assert.equal(
      decideRootCollapse(
        [r('a', 'Web 服务端'), r('b', 'PEIS 体检管理系统'), r('c', '移动端')],
        'PEIS 体检管理系统',
      ),
      null,
    );
  });

  it('两个根与项目名的相似度打平 ⇒ 不动（分不出本体）', () => {
    assert.equal(
      decideRootCollapse([r('a', '端甲'), r('b', '端乙')], 'PEIS 体检管理系统'),
      null,
      '都不像时不许乱扶',
    );
  });

  it('两个根同名 ⇒ 不动（无判据可区分）', () => {
    assert.equal(
      decideRootCollapse([r('a', 'PEIS 体检管理系统'), r('b', 'PEIS 体检管理系统')], 'PEIS 体检管理系统'),
      null,
    );
  });

  it('没有一个像项目名 ⇒ 不动（挡住"随便挑一个当根"）', () => {
    assert.equal(decideRootCollapse([r('a', '数据库层'), r('b', '前端层')], 'PEIS 体检管理系统'), null);
  });

  it('项目名核心串过短 ⇒ 不判', () => {
    assert.equal(decideRootCollapse([r('a', 'Web 服务端'), r('b', '系统管理')], '系统'), null);
  });
});
