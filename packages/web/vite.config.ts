import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 静态产物要同时满足两种投放方式：
 * - GitHub Pages 的子路径（https://<user>.github.io/Guide-of-.../arena/）；
 * - 后端单机形态直接托管 dist（同源）。
 * 所以 base 用相对路径 './'，资源引用不写死根路径。
 */
export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      // 前端与后端共用同一份核心逻辑（判分/组卷/状态机），不在 web 里复制实现
      '@aixx/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5180,
    // core 在 packages/web 之外，dev server 需要放行上一级目录
    fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
  },
})
