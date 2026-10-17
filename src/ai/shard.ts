/**
 * **大项目分批建树**：把骨架切成若干片，每片单独调模型，最后合并成一棵树。
 *
 * ## 为什么需要它
 *
 * 用户口径："由于项目大了可能出现空返回情况，需要分批处理。"
 *
 * "空返回"（`empty-output`）的两个典型成因都跟**规模**直接相关：
 * ① 提示词太长 ⇒ 超出模型上下文／被供应商截断；
 * ② 要求输出的 JSON 太大 ⇒ 模型吐到一半就到上限，或干脆不吐。
 * 单次请求里，"骨架进多少"和"要求出多少"是绑在一起的 —— 分批把这两者同时降下来。
 *
 * ## 分片口径：按**顶层目录**
 *
 * 分片不按文件均分，而是按骨架里的**第一级目录**归组：同一个目录下的文件尽量留在同一片，
 * 模型才能看到"这个模块有哪些文件"的完整上下文（按文件数均分会把同一模块劈开，
 * 建出来的树比不分批还碎）。
 *
 * 这条口径与画布的分区语义一致：**顶层目录 ≈ 一个大功能/子项目**（见 §11.2 的分区视图）。
 *
 * ## 只在真的需要时才分
 *
 * 纯函数、不碰 IO。调用方拿 `shouldShard` 判断，不要"为了保险每次都分批"——
 * 那会把一次模型调用变成 N 次，成本与失败面都放大。
 */

/** 触发分批的文件数阈值：低于它单次请求完全够用（实测 60 个签名文件仍在正常范围）。 */
export const SHARD_THRESHOLD_FILES = 80;

/** 单片最多带多少个文件（超过就按目录再收一次）。 */
export const SHARD_MAX_FILES = 40;

/**
 * **片数上限**：每次调用都要带同一份系统提示词，那是**固定开销** ——
 * 片数越多，"内容"在总成本里的占比越低。实测语境：128 个文件的仓库按顶层目录会切出
 * 17 片（`src` 下每个二级目录一片），17 份系统提示词的开销比骨架本身还大。
 *
 * 取 6：约合"每片 20 个文件"，模型一次要建的节点数也还在单次输出上限之内。
 * 超过就按文件数**从大到小保留**，其余小片并成一片（见 {@link mergeShards}）。
 */
export const SHARD_MAX_COUNT = 6;

/**
 * **一片最多容纳多少个顶层目录**（0.3.45，真机 PEIS 现场）。
 *
 * ## 为什么必须有这条上限
 *
 * 旧 `mergeShards` 的策略是"按文件数从大到小保留前 `maxShards - 1` 片，**其余全并成一片**"。
 * 对"顶层目录很多"的仓库，这会让那一片**吞下几十个互不相关的目录**：
 *
 * ```
 * SHARD_MAX_COUNT = 6, 顶层 25 个目录
 *   ⇒ 片1..5 各 1 个目录
 *   ⇒ 片6  「PEIS.Adapter 等 20 个目录」   ← 模型被要求把 20 个不相关目录组织成一棵树
 * ```
 *
 * 模型只能把它们**串成链**。真机产物因此出现 8 层深的管道：
 * `职业健康业务模块 > … > 客户端资源与启动加载 > 数据访问与仓储层 > 领域模型与业务事件 > Blazor 组件库`
 * —— 跨度从"职业健康"到"Blazor 组件库"，移动端/外检客户端/基础库全被串进同一个分支。
 *
 * **这不是模型的错，是切分方式的错**：一片里塞进越多不相关的东西，模型越没别的办法。
 *
 * ## 修法：均衡分配，而不是"其余全并一片"
 *
 * 片数仍然是 `max(SHARD_MAX_COUNT, ⌈目录数 / 本上限⌉)`，
 * 但剩下的目录**轮流分给各片**，保证每片 ≤ 本上限个目录：
 *
 * ```
 * 25 个目录、上限 6 ⇒ 片数 max(6, ⌈25/6⌉=5) = 6 片（每片 4~5 个目录）
 * ```
 *
 * **片数不变**（不多花系统提示词的钱），但每片的内容规模从"20 个目录"降到"5 个目录"。
 */
export const SHARD_MAX_GROUPS_PER_SHARD = 6;

/** 骨架条目（与 `SkeletonEntry` 同形的最小子集：分片只需要路径与类型）。 */
export interface ShardEntry {
  path: string;
  kind: string;
}

/** 一片骨架：`rootDir` 是它的顶层目录名（`''` 表示仓库根下的散文件）。 */
export interface Shard<T extends ShardEntry> {
  /** 该片的顶层目录（用于给模型/用户说明"这一批是什么范围"）。 */
  rootDir: string;
  entries: T[];
}

/** 一条路径的顶层目录名（`src/a/b.ts` → `src`；`README.md` → `''`）。 */
export function topDirOf(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  const slash = normalized.indexOf('/');
  return slash < 0 ? '' : normalized.slice(0, slash);
}

/**
 * 一条条目**归到哪个顶层组**。
 *
 * 与 {@link topDirOf} 的差别：**目录条目算它自己那一组**。
 * `src`（目录）与 `src/a.ts`（文件）必须同组 —— 否则"目录进空组、文件进 src 组"，
 * 模型在 src 那一批里看不到"src 是个目录、下面有几个直接文件"这条上下文。
 */
function groupKeyOf(entry: ShardEntry): string {
  const normalized = entry.path.replace(/\\/g, '/').replace(/^\.\//, '');
  return topDirOf(entry.kind === 'dir' ? `${normalized}/x` : normalized);
}

/** 需不需要分批（按**文件**数量判断：目录本身几乎不占 token）。 */
export function shouldShard(entries: readonly ShardEntry[]): boolean {
  const files = entries.filter((entry) => entry.kind === 'file').length;
  return files > SHARD_THRESHOLD_FILES;
}

/**
 * 把骨架切成若干片。
 *
 * 规则：
 * 1. 按**顶层目录**归组，每组一片；
 * 2. 某组文件数超过 {@link SHARD_MAX_FILES} 时，**按第二级目录**再拆一层
 *    （避免"所有代码都在 `src/` 下"这种常见布局反而只有一片）；
 * 3. 组内条目顺序保持原样（模型的阅读顺序与骨架一致，结论才稳定）；
 * 4. **空片不产出**（只有目录、没有文件的组没必要单独问模型）。
 */
export function shardSkeleton<T extends ShardEntry>(
  entries: readonly T[],
  options: { maxShards?: number } = {},
): Array<Shard<T>> {
  return mergeShards(splitByTopDir(entries), options.maxShards ?? SHARD_MAX_COUNT);
}

/**
 * 把片数收到上限以内，并**保证每片不超过 {@link SHARD_MAX_GROUPS_PER_SHARD} 个顶层目录**。
 *
 * ## 旧策略错在哪（0.3.45 真机）
 *
 * 旧策略 = "按文件数从大到小保留前 `maxShards - 1` 片，**其余全并成一片**"。
 * 顶层目录一多，那一片就会吞下几十个不相关目录，模型只能把它们串成链
 * （真机：8 层深管道，从「职业健康业务模块」一直串到「Blazor 组件库」）。
 *
 * ## 现策略：均衡分配
 *
 * 1. 片数 `limit = max(maxShards, ⌈目录数 / 每片上限⌉)` —— 目录太多时就多切几片，
 *    否则无论怎么分都会超限；
 * 2. 把各目录按**文件数从大到小**排序，依次放进**当前条目最少**的那一片
 *    （贪心，结果接近均衡）；
 * 3. 单目录的片保持原样（`rootDir` 就是目录名）；多目录的片标注"X 等 N 个目录"。
 *
 * **不再有"合并片吞下 20 个目录"这种事**，片数也不会因为目录多就失控。
 */
export function mergeShards<T extends ShardEntry>(
  shards: Array<Shard<T>>,
  maxShards: number = SHARD_MAX_COUNT,
): Array<Shard<T>> {
  const base = Number.isFinite(maxShards) && maxShards >= 1 ? Math.floor(maxShards) : SHARD_MAX_COUNT;
  if (shards.length === 0) return [];
  /**
   * 目录多到"每片上限"装不下时，**必须多切几片**：
   * 否则要么超限、要么又退回"一片吞几十个目录"的老毛病。
   */
  const limit = Math.max(base, Math.ceil(shards.length / SHARD_MAX_GROUPS_PER_SHARD));
  if (shards.length <= limit) return shards;

  const filesOf = (shard: Shard<T>): number => shard.entries.filter((entry) => entry.kind === 'file').length;
  /** 大到小排：大目录优先占位，避免被塞进已经很满的片。 */
  const ranked = [...shards].sort((a, b) => filesOf(b) - filesOf(a));

  /** 均衡装桶：每次放进"当前条目数最少"的桶（同分取靠前的，保证结果可复现）。 */
  const buckets: Array<Array<Shard<T>>> = Array.from({ length: limit }, () => []);
  const weight = buckets.map(() => 0);
  for (const shard of ranked) {
    let target = 0;
    for (let index = 1; index < buckets.length; index += 1) {
      if (weight[index]! < weight[target]!) target = index;
    }
    buckets[target]!.push(shard);
    weight[target] = weight[target]! + Math.max(1, shard.entries.length);
  }

  return buckets
    .filter((bucket) => bucket.length > 0)
    .map((bucket) => {
      if (bucket.length === 1) return bucket[0] as Shard<T>;
      const first = bucket[0] as Shard<T>;
      return {
        /**
         * 合成片的 `rootDir` 是**给人看/给失败信息用的标签**（不参与任何路径计算），
         * 所以如实写成"最大的那个目录 + 等 N 个目录"，而不是假装它只有一个目录。
         */
        rootDir: `${first.rootDir === '' ? '(仓库根)' : first.rootDir} 等 ${bucket.length} 个目录`,
        entries: bucket.flatMap((shard) => shard.entries),
      };
    });
}

/** 只按顶层目录切（不做片数收敛）；`shardSkeleton` 在它之上加收口。 */
function splitByTopDir<T extends ShardEntry>(entries: readonly T[]): Array<Shard<T>> {
  const byTop = new Map<string, T[]>();
  for (const entry of entries) {
    const key = groupKeyOf(entry);
    const bucket = byTop.get(key);
    if (bucket === undefined) byTop.set(key, [entry]);
    else bucket.push(entry);
  }

  const shards: Array<Shard<T>> = [];
  for (const [rootDir, group] of byTop) {
    const fileCount = group.filter((entry) => entry.kind === 'file').length;
    if (fileCount <= SHARD_MAX_FILES) {
      if (fileCount > 0) shards.push({ rootDir, entries: group });
      continue;
    }
    /** 太大：按**第二级**目录再拆（`src/a` / `src/b` …），拆不动就整组留着（总比丢内容好）。 */
    const bySecond = new Map<string, T[]>();
    for (const entry of group) {
      const normalized = entry.path.replace(/\\/g, '/').replace(/^\.\//, '');
      // 注意 rootDir 为空串时（仓库根下的散文件）不能 slice，否则会把首字符切掉
      const rest = rootDir === '' ? normalized : normalized.slice(rootDir.length + 1);
      const slash = rest.indexOf('/');
      const second = slash < 0 ? '' : `${rootDir}/${rest.slice(0, slash)}`;
      const bucket = bySecond.get(second);
      if (bucket === undefined) bySecond.set(second, [entry]);
      else bucket.push(entry);
    }
    for (const [second, sub] of bySecond) {
      const subFiles = sub.filter((entry) => entry.kind === 'file').length;
      if (subFiles === 0) {
        /**
         * `second === ''` 装的是**这一组自己的目录条目**（如 `src` 本身）：
         * 它没有文件，但它不能丢 —— 模型需要知道"这一片属于哪个目录"。
         * 把它并进**第一个有文件的子片**（而不是丢掉）。
         */
        const host = [...bySecond.entries()].find(
          ([, bucket]) => bucket.filter((entry) => entry.kind === 'file').length > 0,
        );
        if (host !== undefined) host[1].push(...sub);
        else shards.push({ rootDir, entries: sub });
        continue;
      }
      shards.push({ rootDir: second === '' ? rootDir : second, entries: sub });
    }
  }
  return shards;
}
