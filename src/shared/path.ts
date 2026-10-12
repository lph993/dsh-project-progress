/**
 * 路径归一化（**纯函数，宿主面与浏览器面共用**）。
 *
 * ## 为什么单独成一个文件
 *
 * 这段逻辑原先住在 `adapter/workspace-root.ts` 里，那个模块**头顶就 `import { existsSync } from 'node:fs'`**
 * —— 于是浏览器侧（`src/client/**`）只要想比一条工作区路径，就会把 `node:fs` 拖进客户端 bundle。
 * 实测踩到这个坑的方式很隐蔽：客户端产物自检（`scripts/verify-artifacts.mjs`）只验"能执行、注册正确"，
 * **不阻止 node 内建模块被内联**，所以它不会当场报错，而是在浏览器里变成另一个问题。
 * 现在把纯逻辑分出来，宿主侧**再导出**它（`adapter/workspace-root.ts` 保持原 API 不变），
 * 两边各自只依赖自己需要的东西。
 *
 * ## 归一化要解决的问题
 *
 * 同一条路径在手写配置、DSH 工作区注册表、`process.cwd()` 里可能出现
 * `Z:\a\b` / `Z:/a/b` / `z:\a\b\` / `\\?\Z:\a\b` 等写法。直接字符串比较会把
 * "同一个工作区"认成两个，于是**每个写法都新建一个项目**。
 *
 * @param input - 任意写法的路径。
 * @returns 用于**比较**的规范形式（不是用于落盘/展示的路径）。
 */
export function normalizeRootPath(input: string): string {
  let path = input.trim();
  // Windows 的长路径前缀（`\\?\C:\x` / `\\?\UNC\srv\share`）
  if (path.startsWith('\\\\?\\UNC\\')) path = `\\\\${path.slice(8)}`;
  else if (path.startsWith('\\\\?\\')) path = path.slice(4);
  path = path.replace(/\\/g, '/');
  // 去掉结尾斜杠（但要保留根 `/` 与 `C:/`）
  path = path.replace(/\/+$/, '');
  if (/^[a-zA-Z]:$/.test(path)) path = `${path}/`;
  // Windows 盘符大小写不敏感；POSIX 敏感，所以只在小写盘符形态上统一
  if (/^[a-zA-Z]:\//.test(path)) path = path[0]!.toLowerCase() + path.slice(1);
  return path;
}
