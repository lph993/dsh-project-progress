/**
 * **树健康检查**（0.3.48）。
 *
 * ## 为什么要把它做进产品
 *
 * 用户已经问过两次"**这棵树是否健康**"，而我两次都是**临时写脚本跑一遍**才算出来。
 * 那说明"什么算健康"只存在于我的脑子里，**产品自己不会说话** —— 这是最该修的一种缺失：
 * 判据不可见，用户就只能靠感觉。
 *
 * ## 设计纪律
 *
 * 1. **只做可核对的事实判断**，不做"我觉得这棵树不好"这类评价。
 *    每一条问题都必须能落到"哪个节点、违反了哪条"。
 * 2. **判据集中在这个纯函数里**（不看仓库名、不看技术栈），
 *    service 只负责把图与文件系统事实喂进来。
 * 3. **不自动改树**。健康检查用来"看"，修复是另外的入口（`normalizeProjectRoot` /
 *    `regroupShardedBranches` / 面板操作）。**看与改混在一起，出了错就分不清是谁干的。**
 *
 * ## 与大功能上限的关系
 *
 * 提示词从 0.3.22 起就写着"任何节点的直接子节点不超过 6 个"，但**从来没有任何地方校验它**。
 * 真机代价：PEIS 前后几版树里，根的直接子节点分别是 **22 / 16 / 15** 个 ——
 * 每次都要靠人肉数。这条检查就是来替人数的。
 */

/** 树的一个节点（只取健康检查用得到的事实）。 */
export interface HealthNode {
  id: string;
  name: string;
  parentId: string | null;
  kind: string;
  refs: readonly string[];
  description?: string;
  /** 派生状态（`done` / `running` / `pending` / `removed`）。 */
  state: string;
  progress: number;
  /** 生命周期状态（`removed` 的是墓碑，不参与检查）。 */
  selfState: string;
}

export type HealthSeverity = 'error' | 'warn' | 'info';

export interface HealthIssue {
  /** 稳定的机器码（供面板/测试断言，别改）。 */
  code:
    | 'no-root'
    | 'multi-root'
    | 'root-not-project'
    | 'orphan-node'
    | 'too-many-children'
    | 'single-child-chain'
    | 'too-deep'
    | 'name-is-directory'
    | 'refs-missing-target'
    | 'refs-too-broad'
    | 'coverage-gap'
    | 'duplicate-identity'
    | 'no-refs'
    | 'no-description'
    | 'uniform-progress';
  severity: HealthSeverity;
  /** 一句话说清"哪条不对"。 */
  message: string;
  /** 涉及的节点（面板要能点过去；可为空）。 */
  nodeIds: string[];
}

export interface HealthStats {
  nodes: number;
  /** 活着的节点数（去掉墓碑）。 */
  alive: number;
  roots: number;
  maxDepth: number;
  /** 根的直接子节点数。 */
  rootChildren: number;
  /** 没有任何子节点的节点数。 */
  leaves: number;
  refsTotal: number;
  /** 有 refs 的节点数。 */
  nodesWithRefs: number;
  /** 有描述的节点数。 */
  nodesWithDescription: number;
}

export interface HealthReport {
  /** 没有任何 `error` 级问题 ⇒ 健康。 */
  healthy: boolean;
  stats: HealthStats;
  issues: HealthIssue[];
}

export interface HealthInput {
  projectName: string;
  nodes: readonly HealthNode[];
  /**
   * "这条 refs 在工作区里存在吗"——由调用方注入（纯函数不碰 fs）。
   * 省略 = 不做存在性检查（面板在拿不到工作区根时就这样，宁可不说）。
   */
  refExists?: (target: string) => boolean;
  /** 一条命名是否"像某个端/模块"（复用根归位那套判据，别在这里重写）。 */
  looksLikeEndpointName?: (name: string) => boolean;
  /**
   * **仓库里"应当被树覆盖"的顶层目录**（0.3.52，审查 PEIS 时发现的角度）。
   *
   * 由调用方算好（它知道扫描排除项，纯函数不碰 fs）：产物目录（`tmp` / `out` /
   * `packages` / `TestResults`…）不该算进来，否则永远报"没覆盖"。
   *
   * 真机教训：34 个顶层目录里 19 个没有任何 refs 覆盖 —— 其中 `Mobile`（791 项）、
   * `PEIS.FormsOut`（183 项）、`PEIS.DataBase`、`DataR`、`InterfaceAdapter`…
   * **12 个真实源码目录整个没进树**。结构再漂亮，漏掉一整端也谈不上健康。
   */
  knownTopDirs?: readonly string[];
}

/** 大功能上限（与提示词同一条口径）。 */
const MAX_CHILDREN = 6;
/** 超过这个深度就提示（提示词要求"至少 3 层"，但没设上限；真机串链到过 8 层）。 */
const MAX_DEPTH_SOFT = 5;

/** 名字核心串（去括号注释/空白/分隔符）。 */
function coreOf(name: string): string {
  return name
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[\s·・\-—_/\\]+/g, '')
    .trim();
}

/** 公共前缀长度（用于"根是否像项目名"的判断）。 */
function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) index += 1;
  return index;
}

/**
 * 检查这棵树健康不健康。**纯函数**：只吃事实，返回可核对的问题清单。
 */
export function analyzeTreeHealth(input: HealthInput): HealthReport {
  const alive = input.nodes.filter((node) => node.selfState !== 'removed' && node.state !== 'removed');
  const byId = new Map(alive.map((node) => [node.id, node]));
  const childrenOf = new Map<string, HealthNode[]>();
  for (const node of alive) {
    if (node.parentId === null) continue;
    const bucket = childrenOf.get(node.parentId);
    if (bucket === undefined) childrenOf.set(node.parentId, [node]);
    else bucket.push(node);
  }

  const roots = alive.filter((node) => node.parentId === null);
  /** 深度：从根往下走（不递归太深，用显式栈）。 */
  const depthOf = new Map<string, number>();
  const stack: Array<{ id: string; depth: number }> = roots.map((root) => ({ id: root.id, depth: 0 }));
  while (stack.length > 0) {
    const current = stack.pop() as { id: string; depth: number };
    if (depthOf.has(current.id)) continue;
    depthOf.set(current.id, current.depth);
    for (const child of childrenOf.get(current.id) ?? []) {
      stack.push({ id: child.id, depth: current.depth + 1 });
    }
  }

  const issues: HealthIssue[] = [];

  /**
   * **①b 连通性：从根走不到的节点 = 树已经断了**（0.3.61）。
   *
   * ## 为什么必须报
   *
   * 上面的深度只从根往下走，走不到的节点就被**静默跳过**了：
   * 它们照样算进 `alive`/`leaves`/`refsTotal`，却既不算深度、也不报任何问题。
   * 审查探针实测：一棵 6 个活节点、1 个根、另有 `x↔y` 环 + 一个父不存在的孤儿的树，
   * 体检结论是 **`healthy: true`**（只报了根名、单子链之类）。
   *
   * 这类断点的真实成因有两种：**父节点被删/不存在**，或**父子成环**（历史数据、
   * 手改存储、曾经那条"删完父又按旧快照复用 id"的并发 bug）。它们都属于
   * "看板上还在、但已经不属于这棵树" —— 不报出来，用户会拿它当正常进度看。
   *
   * 没有根时（`no-root`）不重复报：所有节点都不可达，那条 error 已经说清了。
   */
  if (roots.length > 0) {
    const unreachable = alive.filter((node) => !depthOf.has(node.id));
    if (unreachable.length > 0) {
      const missingParent = unreachable.filter((node) => node.parentId !== null && !byId.has(node.parentId));
      issues.push({
        code: 'orphan-node',
        severity: 'error',
        message:
          `有 ${unreachable.length} 个节点**从根走不到**（父节点不存在或父子成环）：` +
          `${unreachable.slice(0, 5).map((node) => `「${node.name}」`).join('、')}` +
          `${unreachable.length > 5 ? ' 等' : ''}` +
          (missingParent.length > 0
            ? `；其中 ${missingParent.length} 个的父节点 id 在树里根本不存在`
            : '') +
          ' —— 它们仍被计入统计，但已经不属于这棵树，需要修复父子关系或删掉',
        nodeIds: unreachable.map((node) => node.id),
      });
    }
  }

  /** ① 根：有且只有一个，而且它就是项目本体。 */
  if (roots.length === 0) {
    issues.push({ code: 'no-root', severity: 'error', message: '树里没有任何顶级节点', nodeIds: [] });
  } else if (roots.length > 1) {
    issues.push({
      code: 'multi-root',
      severity: 'error',
      message: `有 ${roots.length} 个顶级节点（应为 1）：${roots.map((root) => `「${root.name}」`).join('、')}`,
      nodeIds: roots.map((root) => root.id),
    });
  } else {
    const root = roots[0] as HealthNode;
    const projectCore = coreOf(input.projectName);
    const rootCore = coreOf(root.name);
    /**
     * 根名与项目名的公共前缀，应当明显长于"随便一个端名"。
     * 拿不到项目名（空串）就不判 —— 没有依据时宁可不说。
     */
    if (projectCore.length >= 4) {
      const prefix = commonPrefix(projectCore, rootCore);
      const looksEndpoint = input.looksLikeEndpointName?.(root.name) === true;
      if (prefix < 4 || looksEndpoint) {
        issues.push({
          code: 'root-not-project',
          severity: 'error',
          message:
            `根是「${root.name}」，不像项目本体「${input.projectName}」（与项目名只共享 ${prefix} 个字符` +
            `${looksEndpoint ? '，且名字像某个端/模块' : ''}）—— 各端会被全挂到它下面，层级方向反了`,
          nodeIds: [root.id],
        });
      }
    }
  }

  /** ② 直接子节点超上限（提示词写了、从来没人校验的那条）。 */
  for (const node of alive) {
    const children = childrenOf.get(node.id) ?? [];
    if (children.length <= MAX_CHILDREN) continue;
    issues.push({
      code: 'too-many-children',
      severity: 'warn',
      message:
        `「${node.name}」有 ${children.length} 个直接子节点（上限 ${MAX_CHILDREN}）` +
        ` —— 这一层摊平了，应当先拆成 2~5 个子功能点`,
      nodeIds: [node.id, ...children.map((child) => child.id)],
    });
  }

  /** ③ 单子链：一个节点只有一个子节点、而那个子节点也只有一个子节点 ⇒ 白占两层。 */
  for (const node of alive) {
    const children = childrenOf.get(node.id) ?? [];
    if (children.length !== 1) continue;
    const only = children[0] as HealthNode;
    if ((childrenOf.get(only.id) ?? []).length !== 1) continue;
    issues.push({
      code: 'single-child-chain',
      severity: 'warn',
      message: `「${node.name}」→「${only.name}」是单子链（各只有 1 个子节点），白占一层`,
      nodeIds: [node.id, only.id],
    });
  }

  /** ④ 过深：真机串链到过 8 层。 */
  const maxDepth = depthOf.size === 0 ? 0 : Math.max(...depthOf.values());
  if (maxDepth > MAX_DEPTH_SOFT) {
    const deepest = [...depthOf.entries()].filter(([, depth]) => depth === maxDepth).map(([id]) => id);
    issues.push({
      code: 'too-deep',
      severity: 'warn',
      message: `最深 ${maxDepth} 层（超过 ${MAX_DEPTH_SOFT} 层）—— 多半是几块并列的东西被串成了一条链`,
      nodeIds: deepest,
    });
  }

  /**
   * ⑤ **节点名就是目录名**（`docs/开发须知.md` §0.0 的否决信号 1）。
   *
   * ## 为什么不用"包装层"那个更花哨的判据（我试过，测试当场判我错）
   *
   * 我第一版写的是"只有一条目录 refs、且全部子节点的 refs 都在该目录之下 ⇒ 包装层"。
   * 但**合法的功能分组在结构上与它一模一样**：
   *
   * ```
   * 「体检业务办理」 refs=src/biz，子节点 refs=src/biz/reg、src/biz/report   ← 完全正当
   * 「Web 服务端」   refs=PEIS.Web，子节点全在 PEIS.Web/ 下                    ← 人为包装层
   * ```
   *
   * 光看 refs 分不开这两者，硬判只会把每一次正常的分组都报成问题。
   * 所以改用**可核对的**信号：**节点名等于它引用的那个目录名**（或等于顶层目录名）。
   * 这时它确实不是在描述功能，只是在复述目录。
   */
  const directoryNames = new Set<string>();
  for (const node of alive) {
    for (const ref of node.refs) {
      const normalized = String(ref).replace(/\\/g, '/').replace(/\/+$/, '');
      if (normalized === '') continue;
      const segments = normalized.split('/');
      directoryNames.add((segments[segments.length - 1] ?? '').toLowerCase());
      if (segments.length === 1) directoryNames.add(normalized.toLowerCase());
    }
  }
  for (const node of alive) {
    const name = coreOf(node.name).toLowerCase();
    if (name === '') continue;
    if (!directoryNames.has(name)) continue;
    /** 根不在这里判（根有专门的 `root-not-project`，避免同一条问题报两遍）。 */
    if (node.parentId === null) continue;
    issues.push({
      code: 'name-is-directory',
      severity: 'warn',
      message:
        `「${node.name}」的名字就是一个目录名 —— 它没有描述"这块要做什么"，` +
        '而是把文件存放方式当成了功能名（目录只是好分类，代表不了功能）',
      nodeIds: [node.id],
    });
  }

  /** ⑥ refs 指向不存在的路径（模型最容易编造的东西）。 */
  if (input.refExists !== undefined) {
    const refExists = input.refExists;
    const missingByNode: Array<{ node: HealthNode; missing: string[] }> = [];
    for (const node of alive) {
      const missing = node.refs.map((ref) => String(ref)).filter((ref) => !refExists(ref));
      if (missing.length > 0) missingByNode.push({ node, missing });
    }
    if (missingByNode.length > 0) {
      const total = missingByNode.reduce((sum, entry) => sum + entry.missing.length, 0);
      issues.push({
        code: 'refs-missing-target',
        severity: 'warn',
        message:
          `${missingByNode.length} 个节点共 ${total} 条 refs 指向**工作区里不存在的路径**` +
          `（如「${missingByNode[0]?.node.name}」的 ${missingByNode[0]?.missing.slice(0, 2).join('、')}）` +
          '—— 身份键按这些路径算，写错会让下次建树认错节点',
        nodeIds: missingByNode.map((entry) => entry.node.id),
      });
    }
  }

  /**
   * ⑦b **refs 太宽**：一个节点的目录 refs **把别的节点的范围整个包进去了**（0.3.52）。
   *
   * ## 真机现场（审 PEIS 树时发现）
   *
   * 「体检业务服务」的 refs 是 `PEIS.Web, PEIS.WebApi, PEIS.Service, TimerServer,
   * PEIS.Register, PEIS.FormReg` —— 其中 **`PEIS.Web` 是整个 Web 工程**。
   * 它一条 refs 就覆盖了**另外 26 个节点**的范围（那些节点的 refs 都在 `PEIS.Web/` 之下）。
   *
   * 这不是"父子粗细不同"（父子关系的重叠是正常的：父描述整块、子描述其中一部分），
   * 而是**平级/跨枝的两处都在声称覆盖同一片代码** —— 语义上说不通，而且会让身份键互相干扰。
   *
   * ## 判据（可核对）
   *
   * 两个节点**互不为祖先/后代**，且 A 的某条 ref 是 B 某条 ref 的**前缀目录** ⇒ A 太宽。
   * 反过来（B 是 A 的前缀）同理。
   */
  const relations = new Map<string, ReadonlySet<string>>();
  for (const node of alive) {
    const ancestors = new Set<string>();
    let cursor = node.parentId;
    const seen = new Set<string>();
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      ancestors.add(cursor);
      cursor = byId.get(cursor)?.parentId ?? null;
    }
    relations.set(node.id, ancestors);
  }
  const related = (a: HealthNode, b: HealthNode): boolean =>
    relations.get(a.id)?.has(b.id) === true || relations.get(b.id)?.has(a.id) === true;
  const normalizeRef = (ref: string): string => String(ref).replace(/\\/g, '/').replace(/\/+$/, '');

  /** 每个节点"包住了多少个平级节点"（用于挑出最宽的那几个）。 */
  const broadness = new Map<string, string[]>();
  const withRefs = alive.filter((node) => node.refs.length > 0);
  for (let i = 0; i < withRefs.length; i += 1) {
    for (let j = i + 1; j < withRefs.length; j += 1) {
      const a = withRefs[i] as HealthNode;
      const b = withRefs[j] as HealthNode;
      if (related(a, b)) continue;
      const aCoversB = a.refs.some((ra) => {
        const base = normalizeRef(ra);
        return base !== '' && b.refs.some((rb) => normalizeRef(rb).startsWith(`${base}/`));
      });
      const bCoversA = b.refs.some((rb) => {
        const base = normalizeRef(rb);
        return base !== '' && a.refs.some((ra) => normalizeRef(ra).startsWith(`${base}/`));
      });
      if (aCoversB) {
        const arr = broadness.get(a.id) ?? [];
        arr.push(b.name);
        broadness.set(a.id, arr);
      }
      if (bCoversA) {
        const arr = broadness.get(b.id) ?? [];
        arr.push(a.name);
        broadness.set(b.id, arr);
      }
    }
  }
  const broadNodes = [...broadness.entries()]
    .map(([id, covered]) => ({ id, name: byId.get(id)?.name ?? id, covered }))
    .sort((a, b) => b.covered.length - a.covered.length)
    .slice(0, 5);
  if (broadNodes.length > 0) {
    const top = broadNodes[0] as { id: string; name: string; covered: string[] };
    issues.push({
      code: 'refs-too-broad',
      severity: 'warn',
      message:
        `${broadNodes.length} 个节点的 refs **把别的节点的范围整个包了进去**：` +
        `最宽的是「${top.name}」（它的目录 refs 覆盖了另外 ${top.covered.length} 个节点：` +
        `${top.covered.slice(0, 4).join('、')}${top.covered.length > 4 ? '…' : ''}）。` +
        '这类"一条 refs 指整个工程"的节点应当收窄到它真正负责的那部分',
      nodeIds: broadNodes.map((entry) => entry.id),
    });
  }

  /**
   * ⑦c **覆盖缺口**：仓库里有顶层目录**一条 refs 都没提到**（0.3.52）。
   *
   * 结构再漂亮，漏掉一整端也不叫健康 —— 真机漏掉的是 `Mobile`（791 项）等 12 个真实源码目录。
   * 调用方传进来的 `knownTopDirs` 已排除产物目录（`tmp` / `out` / `packages`…），
   * 所以这里报出来的每一条都值得看。
   */
  if (input.knownTopDirs !== undefined && input.knownTopDirs.length > 0) {
    const allRefs = alive.flatMap((node) => node.refs.map(normalizeRef));
    const uncovered = input.knownTopDirs.filter(
      (dir) => !allRefs.some((ref) => ref === dir || ref.startsWith(`${dir}/`)),
    );
    if (uncovered.length > 0) {
      issues.push({
        code: 'coverage-gap',
        severity: 'warn',
        message:
          `仓库里有 **${uncovered.length}/${input.knownTopDirs.length} 个顶层目录没有任何 refs 覆盖**：` +
          `${uncovered.slice(0, 8).join('、')}${uncovered.length > 8 ? ' 等' : ''}` +
          ' —— 这些区域对树来说等于不存在（多半是骨架没把它们送进模型，或模型忽略了）',
        nodeIds: [],
      });
    }
  }

  /** ⑦ 身份重复：多个活节点共用同一批 refs ⇒ 同一份代码被评估了两次。 */
  const byRefSet = new Map<string, HealthNode[]>();
  for (const node of alive) {
    if (node.refs.length === 0) continue;
    const key = [...node.refs].map((ref) => String(ref).replace(/\\/g, '/')).sort().join('|');
    const bucket = byRefSet.get(key);
    if (bucket === undefined) byRefSet.set(key, [node]);
    else bucket.push(node);
  }
  for (const [, same] of byRefSet) {
    if (same.length < 2) continue;
    issues.push({
      code: 'duplicate-identity',
      severity: 'warn',
      message: `${same.length} 个节点引用同一批路径（${same.map((node) => `「${node.name}」`).join('、')}）—— 同一份代码被建了两个节点`,
      nodeIds: same.map((node) => node.id),
    });
  }

  /**
   * ⑧ 光杆无引用 / 无描述：不影响结构，但影响可跟踪性（info 级）。
   *
   * ⚠️ **只报"整棵子树都没有 refs"的节点**（0.3.51 修正）。
   *
   * 原来只判"这个节点自己有没有 refs"，于是**归拢建出来的功能组**全被误报 ——
   * 真机 6 个组（「体检业务办理与检查」等）自身没有 refs，但它们的子节点合计 121 条 refs。
   * 聚合节点**本来就不该有自己那一份 refs**（它描述的是"这组功能"，不是某段代码）。
   *
   * 判据改成：自己没 refs、**且子树里也没有任何 refs** ⇒ 那才真叫"无法核对它覆盖哪块代码"。
   */
  const subtreeHasRefs = (id: string, seen: Set<string> = new Set()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const self = byId.get(id);
    if (self !== undefined && self.refs.length > 0) return true;
    return (childrenOf.get(id) ?? []).some((child) => subtreeHasRefs(child.id, seen));
  };
  const noRefs = alive.filter((node) => node.refs.length === 0 && !subtreeHasRefs(node.id));
  if (noRefs.length > 0) {
    issues.push({
      code: 'no-refs',
      severity: 'info',
      message:
        `${noRefs.length} 个节点**连子节点都没有任何 refs**（无法核对它到底覆盖哪块代码）` +
        '—— 只报"整棵子树都空"的；功能组这类聚合节点自身 refs 为空是正常的',
      nodeIds: noRefs.map((node) => node.id),
    });
  }
  const noDescription = alive.filter(
    (node) => node.description === undefined || node.description.trim() === '',
  );
  if (noDescription.length > 0) {
    issues.push({
      code: 'no-description',
      severity: 'info',
      message: `${noDescription.length} 个节点没有描述（看板上只能看到名字）`,
      nodeIds: noDescription.map((node) => node.id),
    });
  }

  /** ⑨ 进度全都一样：说明没真评估，"0%" 会被误读成"没做"。 */
  const progresses = [...new Set(alive.map((node) => Math.round(node.progress * 1000) / 1000))];
  if (alive.length >= 5 && progresses.length === 1) {
    issues.push({
      code: 'uniform-progress',
      severity: 'info',
      message: `全部 ${alive.length} 个节点的进度都是 ${Math.round((progresses[0] ?? 0) * 100)}% —— 更像"没评估"而不是"真的一样"`,
      nodeIds: alive.map((node) => node.id),
    });
  }

  const rootChildren = roots.length === 1 ? (childrenOf.get((roots[0] as HealthNode).id) ?? []).length : 0;
  return {
    healthy: issues.every((issue) => issue.severity !== 'error'),
    stats: {
      nodes: input.nodes.length,
      alive: alive.length,
      roots: roots.length,
      maxDepth,
      rootChildren,
      leaves: alive.filter((node) => (childrenOf.get(node.id) ?? []).length === 0).length,
      refsTotal: alive.reduce((sum, node) => sum + node.refs.length, 0),
      nodesWithRefs: alive.filter((node) => node.refs.length > 0).length,
      nodesWithDescription: alive.filter(
        (node) => node.description !== undefined && node.description.trim() !== '',
      ).length,
    },
    issues,
  };
}

/** 把报告压成一行（进建树说明/面板提示，不刷屏）。 */
export function summarizeHealth(report: HealthReport): string {
  const errors = report.issues.filter((issue) => issue.severity === 'error');
  const warns = report.issues.filter((issue) => issue.severity === 'warn');
  const stats = report.stats;
  const head = `树体检：${stats.alive} 节点 / 根 ${stats.roots} 个 / 根下 ${stats.rootChildren} 支 / 最深 ${stats.maxDepth} 层 / refs ${stats.refsTotal} 条`;
  if (report.issues.length === 0) return `${head} —— 没有发现问题 ✓`;
  const parts = [...errors, ...warns].map((issue) => issue.message);
  const infos = report.issues.filter((issue) => issue.severity === 'info');
  const tail =
    parts.length > 0
      ? `；**${parts.length} 项要处理**：${parts.slice(0, 3).join('；')}${parts.length > 3 ? `…（另 ${parts.length - 3} 项）` : ''}`
      : '';
  const infoTail = infos.length > 0 ? `；另 ${infos.length} 项提示（无引用/无描述/进度整齐之类）` : '';
  return `${head}${tail}${infoTail}`;
}
