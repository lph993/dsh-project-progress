/**
 * **"为未归属的改动新建节点"** 需要的一点纯逻辑（0.3.69，可单测）。
 *
 * 面板拿到的是"刚被改过、但不在任何节点 refs 里"的文件路径列表；
 * 要让用户少打字，就得从这些路径里猜一个**像样的默认节点名**。猜错了也只是默认值
 * （输入框可改），但猜得离谱会让人多改三秒 —— 所以这里的规则要能一眼看懂、可复现。
 */
import type { RefType } from '../shared/types.ts';

/** 统一成正斜杠、去尾部斜杠、去 `./`（不改大小写：名字要给人看）。 */
export function normalizeForLabel(path: string): string {
  let value = path.trim().replace(/\\/g, '/');
  while (value.startsWith('./')) value = value.slice(2);
  value = value.replace(/\/{2,}/g, '/');
  if (value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

/** 取父目录（`a/b/c.ts` → `a/b`；没有目录 → `''`）。 */
export function dirOf(path: string): string {
  const normalized = normalizeForLabel(path);
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '' : normalized.slice(0, index);
}

/**
 * 所有路径的**公共目录**（按整段比较，不做字符串前缀）。
 *
 * 例：`updater-rust/src/bin/updater/pkgbuild.rs` 与 `updater-rust/src/bin/updater.rs`
 * ⇒ `updater-rust/src/bin`（再往上就没有共同点了）。
 */
export function commonDirOf(paths: readonly string[]): string {
  const dirs = paths.map(dirOf).filter((dir) => dir !== '');
  if (dirs.length === 0) return '';
  let common = dirs[0]!.split('/');
  for (const dir of dirs.slice(1)) {
    const parts = dir.split('/');
    const shared: string[] = [];
    for (let i = 0; i < Math.min(common.length, parts.length); i += 1) {
      if (common[i] !== parts[i]) break;
      shared.push(common[i]!);
    }
    common = shared;
    if (common.length === 0) break;
  }
  return common.join('/');
}

/**
 * 默认节点名：`未归类改动（<公共目录>）`；路径都在根下时退回 `未归类改动`。
 *
 * 不拿文件名当名字：一次通常有多个文件，挑哪个都误导；目录名至少说明"这块没人管"。
 */
export function suggestNodeName(paths: readonly string[]): string {
  const dir = commonDirOf(paths);
  return dir === '' ? '未归类改动' : `未归类改动（${dir}）`;
}

/**
 * 从扩展名推引用类型（`RefType`）。
 *
 * 为什么按扩展名：`refs` 的类型决定"这个节点覆盖什么"，而面板只知道文件路径；
 * 猜错的代价很小（路径本身才是身份键），猜对能省一次手动改。
 */
export function refTypeOf(path: string): RefType {
  const normalized = normalizeForLabel(path).toLowerCase();
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (/\.(md|markdown)$/.test(name)) return 'md';
  if (/\.(png|jpe?g|gif|webp|svg|pdf|zip|tar|gz|tgz|7z|exe|dll|so|dylib|bin|wasm|lock)$/.test(name)) {
    return 'artifact';
  }
  return 'code';
}
