/**
 * **"这个节点的代码正在被改"**（0.3.68）——把「最近改动的文件」映射到节点。
 *
 * ## 为什么需要它
 *
 * 节点级 loading 只认"这一轮写过它"（`activeNodeIds`），而 `pm_*` 是收尾才调的：
 * 一个正在改代码的长回合里，图上什么都没有（0.3.66 的结论）。
 * 但**改的是哪些文件**宿主是知道的（`git status` 一次就能拿到，含 shell 改的）。
 * 节点的 `refs` 恰好声明了"这个节点覆盖哪些文件/目录" ⇒ 两者相交就是
 * **"这个节点的代码此刻正在被改"**，这是比"会话在忙"强得多的证据。
 *
 * ## 为什么是纯函数
 *
 * 路径匹配是最容易写错、也最容易在真机上"看起来对"的一类逻辑：
 * - 反斜杠/正斜杠混用（Windows 宿主 + 面板混着传）；
 * - `dir` 引用要按**前缀**匹配（`src/ai` 覆盖 `src/ai/prompt.ts`），而文件引用只能**精确**匹配；
 * - 大小写（Windows 文件系统不敏感，Linux 敏感）；
 * - 绝对路径不该参与（refs 的契约是"工作区相对"）。
 *
 * 所以把它抽出来单测，而不是埋在 service 的轮询里。
 */
export interface RefLike {
  /** ref 类型（`dir` / `code` / `md` / `note` / `artifact`）。匹配规则不看它 —— 见下。 */
  type?: string | undefined;
  /** 工作区相对路径（契约见 `shared/types.ts` 的 `Ref`）。 */
  target: string;
}

export interface HotNodeInput {
  id: string;
  refs?: readonly RefLike[] | undefined;
}

/**
 * 归一化一个工作区相对路径：正斜杠、去 `./`、去尾部 `/`、**小写**。
 *
 * 小写是刻意的：本项目的主要用户环境是 Windows（大小写不敏感），
 * 而 git 在 Windows 上也可能按磁盘的真实大小写回路径。为极少数"同目录下仅大小写不同"
 * 的 Linux 仓库冒误报风险，比在这里漏报（用户报的就是"看不到"）划算。
 */
export function normalizeWorkspacePath(raw: string): string {
  let path = raw.trim().replace(/\\/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  path = path.replace(/\/{2,}/g, '/');
  if (path.endsWith('/')) path = path.slice(0, -1);
  return path.toLowerCase();
}

/** 绝对路径（`C:/...` 或 `/...`）不参与匹配 —— refs 的契约是工作区相对。 */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-z]:\//i.test(path);
}

/**
 * 一个 ref 是否覆盖某个改动路径。
 *
 * - **精确相等**永远算命中；
 * - **前缀匹配**（`目标/` 开头）只在"这个 target 看起来是目录"时开放：
 *   `type === 'dir'`，或者最后一段没有扩展名（`src/ai` 这种）。
 *
 * 为什么要这道闸：AI 建树时 `type` 经常标错（目录标成 `code`），
 * 所以不能只信 `type`；但反过来，"文件引用按前缀匹配"会把
 * `src/a.ts` 误伤到 `src/a.tsx` 这类兄弟文件上 —— 用"带扩展名就是文件"这条
 * 常识把两种误判都压住。
 */
export function refCoversPath(ref: RefLike, changedPath: string): boolean {
  const target = normalizeWorkspacePath(ref.target);
  const path = normalizeWorkspacePath(changedPath);
  if (target === '' || target === '.' || isAbsolutePath(target)) return false;
  if (isAbsolutePath(path)) return false;
  if (path === target) return true;
  /** 最后一段带扩展名 ⇒ 按文件对待（只精确匹配）。 */
  const looksLikeFile = /[^/]+\.[^/]+$/.test(target);
  const mayBeDirectory = ref.type === 'dir' || !looksLikeFile;
  return mayBeDirectory && path.startsWith(`${target}/`);
}

/**
 * 把"最近改动的文件"映射到节点 id（按输入顺序、去重）。
 *
 * @param nodes - 带 `refs` 的节点（只读；`refs` 缺省 ⇒ 永不命中）。
 * @param changedPaths - 工作区相对路径（大小写/分隔符不限，内部归一）。
 */
export function hotNodeIdsOf(
  nodes: readonly HotNodeInput[],
  changedPaths: readonly string[],
): string[] {
  const changed = changedPaths
    .map(normalizeWorkspacePath)
    .filter((path) => path !== '' && !isAbsolutePath(path));
  if (changed.length === 0) return [];
  const hot: string[] = [];
  for (const node of nodes) {
    if (node.refs === undefined || node.refs.length === 0) continue;
    const covered = node.refs.some((ref) =>
      changed.some((path) => refCoversPath(ref, path)),
    );
    if (covered) hot.push(node.id);
  }
  return hot;
}
