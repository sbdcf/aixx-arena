/**
 * 测试用解析钩子：把 `@aixx/core` 与 `@/...` 直接指向源码目录。
 *
 * 原因：
 * 1. npm workspaces 在 node_modules 里建的是 junction（指向 packages/core），
 *    而 Node 的 type stripping 明确拒绝 `node_modules` 下的 .ts 文件
 *    （ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）。绕开 junction、解析到真实源码路径即可。
 * 2. 前端源码用 Vite 的 `@/` 别名；Node 不认识，这里补上。
 *
 * 用法：node --import ./packages/web/test/loader.mjs --test ...
 */
import { registerHooks } from 'node:module'

const coreEntry = new URL('../../core/src/index.ts', import.meta.url).href
const srcDir = new URL('../src/', import.meta.url)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@aixx/core') {
      return { url: coreEntry, shortCircuit: true }
    }
    if (specifier.startsWith('@/')) {
      return { url: new URL(specifier.slice(2), srcDir).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
