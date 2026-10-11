/**
 * 「进度自动回写」的候选挑选契约（纯函数）。
 *
 * 为什么值得单独钉死：这层决定**什么时候去催模型汇报进度**。催错了（把无关节点列出来）
 * 会让模型去改没干的活，等于往事实源里灌错误；催漏了则退化成今天实测到的样子 ——
 * 32 个叶节点全卡在 0.50–0.70、完成数 0、整体比例永远冻在 0.649。
 *
 * 另有一条硬边界必须守着：**本模块只挑候选、绝不产生数字**。数字只有干活的模型知道
 * （`session/prompt.ts` 的既定前提），宿主能做的只有"有证据的推断"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_HITS_PER_CANDIDATE,
  blindSpotText,
  pickReportCandidates,
  refCoversPath,
  reportNudgeText,
  uncoveredPaths,
  type CandidateNode,
} from '../../src/session/report-candidate.ts';

function node(partial: Partial<CandidateNode> & { nodeId: string }): CandidateNode {
  return { name: partial.nodeId, done: false, ...partial };
}

// ── refs 覆盖判定 ───────────────────────────────────────────────

test('目录 ref 覆盖其下所有文件，但不覆盖同前缀的兄弟目录', () => {
  assert.equal(refCoversPath('src', 'src/a.ts'), true, '目录下的文件应命中');
  assert.equal(refCoversPath('src', 'src/deep/a.ts'), true, '嵌套也算命中');
  assert.equal(refCoversPath('src', 'src/main.ts'), true);
  assert.equal(refCoversPath('src', 'srcx/a.ts'), false, 'srcx 不是 src 的子路径（前缀陷阱）');
  assert.equal(refCoversPath('src', 'test/a.ts'), false);
});

test('文件 ref 只命中它自己，不命中同目录其它文件', () => {
  assert.equal(refCoversPath('src/a.ts', 'src/a.ts'), true);
  assert.equal(refCoversPath('src/a.ts', 'src/b.ts'), false, '同目录的兄弟文件不命中');
  assert.equal(refCoversPath('src/a.ts', 'other/a.ts'), false);
  /**
   * `src/a.ts` 覆盖 `src/a.ts/x`：**刻意保守**。
   *
   * `refs` 的 target 只是一条路径，写法上分不出它是文件还是目录（没有后缀约定可依赖）。
   * 两种判错的代价不对称：判成"目录"最多多列一个候选（模型会自己看一眼再决定报不报），
   * 判成"文件"则会**漏掉真实进展** —— 而"漏报"正是这条功能要治的病。所以取宽的一侧。
   */
  assert.equal(refCoversPath('src/a.ts', 'src/a.ts/x'), true, '路径之下的内容算它负责（保守取宽）');
});

test('路径归一化：反斜杠、重复斜杠、./ 前缀、尾斜杠都视为同一路径', () => {
  assert.equal(refCoversPath('src\\domain', 'src/domain/a.ts'), true, '反斜杠 ref');
  assert.equal(refCoversPath('src//domain/', './src/domain/a.ts'), true, '重复斜杠 + ./ + 尾斜杠');
  assert.equal(refCoversPath('', 'src/a.ts'), false, '空 ref 不命中');
  assert.equal(refCoversPath('src', ''), false, '空路径不命中');
});

// ── 候选挑选 ────────────────────────────────────────────────────

test('按 refs 命中挑候选，并给出命中的具体文件（证据可见）', () => {
  const nodes = [
    node({ nodeId: 'n1', name: '宿主 HTTP 路由', refs: [{ type: 'dir', target: 'src/adapter/http.ts' }] }),
    node({ nodeId: 'n2', name: 'AI 建树', refs: [{ type: 'dir', target: 'src/ai' }] }),
  ];
  const picked = pickReportCandidates(['src/adapter/http.ts', 'src/ai/parse.ts'], nodes);
  assert.deepEqual(
    picked.map((c) => c.nodeId).sort(),
    ['n1', 'n2'],
  );
  assert.deepEqual(picked.find((c) => c.nodeId === 'n1')?.hits, ['src/adapter/http.ts']);
  assert.deepEqual(picked.find((c) => c.nodeId === 'n2')?.hits, ['src/ai/parse.ts']);
});

test('没有 refs 的抽象节点不参与判断（无从判断就不猜）', () => {
  const picked = pickReportCandidates(['src/a.ts'], [node({ nodeId: 'n1', refs: [] }), node({ nodeId: 'n2' })]);
  assert.deepEqual(picked, [], '既没 refs 也没命中的节点不该被列出来');
});

test('已完成 / 已删除的节点不再被推着走', () => {
  const nodes = [
    node({ nodeId: 'done', refs: [{ type: 'dir', target: 'src' }], done: true }),
    node({ nodeId: 'live', refs: [{ type: 'dir', target: 'src' }] }),
  ];
  const picked = pickReportCandidates(['src/a.ts'], nodes);
  assert.deepEqual(picked.map((c) => c.nodeId), ['live']);
});

test('本回合没碰过文件 → 没有候选（不打扰）', () => {
  const nodes = [node({ nodeId: 'n1', refs: [{ type: 'dir', target: 'src' }] })];
  assert.deepEqual(pickReportCandidates([], nodes), []);
});

test('同一文件重复出现只算一次（去重后再算命中数）', () => {
  const picked = pickReportCandidates(
    ['src/a.ts', 'src\\a.ts', './src/a.ts'],
    [node({ nodeId: 'n1', refs: [{ type: 'dir', target: 'src' }] })],
  );
  assert.equal(picked[0]?.hitTotal, 1, '三种写法是同一个文件');
});

test('命中数多的排前面；并列时按 nodeId 保证可复现', () => {
  const nodes = [
    node({ nodeId: 'b', refs: [{ type: 'dir', target: 'src/a' }] }),
    node({ nodeId: 'a', refs: [{ type: 'dir', target: 'src' }] }),
    node({ nodeId: 'c', refs: [{ type: 'dir', target: 'src/a' }] }),
  ];
  const picked = pickReportCandidates(['src/a/x.ts', 'src/b/y.ts'], nodes);
  // a 命中 2 个（src 覆盖 a 与 b），b/c 各命中 1 个 → a 在最前；b/c 并列按 id
  assert.deepEqual(picked.map((c) => c.nodeId), ['a', 'b', 'c']);
});

test('命中文件过多时截断，但 hitTotal 保留真实数量', () => {
  const many = Array.from({ length: MAX_HITS_PER_CANDIDATE + 3 }, (_, i) => `src/f${i}.ts`);
  const picked = pickReportCandidates(many, [node({ nodeId: 'n1', refs: [{ type: 'dir', target: 'src' }] })]);
  assert.equal(picked[0]?.hits.length, MAX_HITS_PER_CANDIDATE);
  assert.equal(picked[0]?.hitTotal, many.length);
});

// ── 提醒文本 ────────────────────────────────────────────────────

test('提醒文本说清节点、文件证据、工具，并明确"数字自己给、不许编"', () => {
  const text = reportNudgeText(
    pickReportCandidates(['src/adapter/http.ts'], [
      node({ nodeId: 'n1', name: '宿主 HTTP 路由', refs: [{ type: 'dir', target: 'src/adapter' }] }),
    ]),
  );
  assert.ok(text !== undefined);
  assert.match(text, /宿主 HTTP 路由/);
  assert.match(text, /src\/adapter\/http\.ts/, '要把命中文件摆出来作为证据');
  assert.match(text, /pm_report/, '要给出可执行的工具');
  assert.match(text, /没有依据的数字不要写/, '必须禁止编数字（与提示词纪律同一口径）');
});

test('没有候选就不产生提醒（宁少不吵）', () => {
  assert.equal(reportNudgeText([]), undefined);
});

test('候选过多时截断并说明还有多少（不把上下文塞满）', () => {
  const nodes = Array.from({ length: 11 }, (_, i) =>
    node({ nodeId: `n${String(i).padStart(2, '0')}`, refs: [{ type: 'dir', target: 'src' }] }),
  );
  const text = reportNudgeText(pickReportCandidates(['src/a.ts'], nodes));
  assert.ok(text !== undefined);
  assert.match(text, /另有 3 个节点/, '11 个候选、上限 8 → 另有 3 个');
});

test('提醒文本是确定性的：同样输入渲染出同样文本', () => {
  const nodes = [
    node({ nodeId: 'n2', name: 'B', refs: [{ type: 'dir', target: 'src/b' }] }),
    node({ nodeId: 'n1', name: 'A', refs: [{ type: 'dir', target: 'src/a' }] }),
  ];
  const a = reportNudgeText(pickReportCandidates(['src/a/x.ts', 'src/b/y.ts'], nodes));
  const b = reportNudgeText(pickReportCandidates(['src/b/y.ts', 'src/a/x.ts'], nodes));
  assert.equal(a, b, '输入顺序不同不该改变输出（否则 diff 与提示词缓存全是噪声）');
});

// ── 树盲区（本回合改了、但没有任何节点负责它）────────────────────
//
// 这一组是用户质疑的落点：「这些是你刚加的，为什么需要我提醒你才行」——
// 做完一个功能、提交了、推送了，树上却没有它的落点，而这本该被自动发现。

test('未覆盖路径：改动落在所有节点 refs 之外时被抓出来', () => {
  const nodes = [node({ nodeId: 'n1', refs: [{ type: 'dir', target: '.codeartsdoer' }] })];
  const uncovered = uncoveredPaths(['server/crates/entity/src/genetics.rs', '.codeartsdoer/mcp/x.json'], nodes);
  assert.deepEqual(uncovered, ['server/crates/entity/src/genetics.rs'], '只有没人负责的那个才算盲区');
});

test('未覆盖路径：全部被覆盖时为空（不打扰）', () => {
  const nodes = [node({ nodeId: 'n1', refs: [{ type: 'dir', target: 'src' }] })];
  assert.deepEqual(uncoveredPaths(['src/a.ts', 'src/deep/b.ts'], nodes), []);
});

test('未覆盖路径：已完成节点的 refs 不算覆盖（它不再负责那片地了）', () => {
  const nodes = [node({ nodeId: 'n1', refs: [{ type: 'dir', target: 'src' }], done: true })];
  assert.deepEqual(uncoveredPaths(['src/a.ts'], nodes), ['src/a.ts']);
});

test('未覆盖路径：没有 refs 的抽象节点覆盖不了任何东西', () => {
  assert.deepEqual(uncoveredPaths(['a/b.ts'], [node({ nodeId: 'n1' })]), ['a/b.ts']);
});

test('未覆盖路径：归一化 + 去重 + 空输入不产生结果', () => {
  const nodes = [node({ nodeId: 'n1', refs: [{ type: 'dir', target: 'src' }] })];
  assert.deepEqual(uncoveredPaths(['out\\a.ts', './out/a.ts', 'out/a.ts'], nodes), ['out/a.ts'], '三种写法同一文件');
  assert.deepEqual(uncoveredPaths([], nodes), []);
  assert.deepEqual(uncoveredPaths([''], nodes), []);
});

test('盲区提醒：说清文件、指出树上缺节点、并给出建节点工具与 refs 要求', () => {
  const text = blindSpotText(['server/crates/entity/src/genetics.rs']);
  assert.ok(text !== undefined);
  assert.match(text, /server\/crates\/entity\/src\/genetics\.rs/, '要把盲区文件摆出来当证据');
  assert.match(text, /不属于任何已有节点/, '说清这是盲区，不是"该更新某节点"');
  assert.match(text, /pm_add/, '要给出可执行的工具');
  assert.match(text, /refs/, '并告诉它把 refs 指向这些路径，下次才不再是盲区');
  assert.match(text, /别让进度靠人记得/, '点明这条机制的目的');
});

test('盲区提醒：没有盲区就不产生文本；过多时截断但说清总数', () => {
  assert.equal(blindSpotText([]), undefined);
  assert.equal(blindSpotText(['']), undefined);
  const many = Array.from({ length: 9 }, (_, i) => `out/f${i}.ts`);
  const text = blindSpotText(many);
  assert.ok(text !== undefined);
  assert.match(text, /等 9 个文件/, '超出上限时要说清一共有多少');
});

test('盲区与候选互不替代：同一份改动可以两者都为真', () => {
  const nodes = [node({ nodeId: 'n1', name: '已有节点', refs: [{ type: 'dir', target: 'src/a' }] })];
  const touched = ['src/a/x.ts', 'server/b.rs'];
  assert.equal(pickReportCandidates(touched, nodes).length, 1, '落在 src/a 的那份要提醒更新节点');
  assert.deepEqual(uncoveredPaths(touched, nodes), ['server/b.rs'], '落在盲区的那份要提醒建节点 —— 两件事同时成立');
});
