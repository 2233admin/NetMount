import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitest.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    // 使用 jsdom 环境进行组件测试
    environment: 'jsdom',
    
    // 全局测试超时时间
    testTimeout: 10000,
    
    // 包含测试文件的模式
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'cli/**/*.{test,spec}.ts'],
    
    // 排除的文件
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],
    
    // 全局测试设置
    setupFiles: ['./src/test/setup.ts'],
    
    // CSS 模块支持
    css: true,
    
    // 覆盖率配置
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.{ts,tsx}', 'cli/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/test/**',
        'src/**/*.{test,spec}.{ts,tsx}',
        'cli/**/*.{test,spec}.ts',
        'src/main.tsx',
        'src/app.tsx',
      ],
      thresholds: {
        lines: 0,
        functions: 0,
        branches: 0,
        statements: 0,
      },
    },
    
    // CI 友好输出
    reporters: ['default'],
    
    // 模拟配置
    mockReset: true,
    clearMocks: true,
    
    // 全局测试 API
    globals: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@services': path.resolve(__dirname, './src/services'),
      '@utils': path.resolve(__dirname, './src/utils'),
      '@type': path.resolve(__dirname, './src/type'),
      '@controller': path.resolve(__dirname, './src/controller'),
      '@page': path.resolve(__dirname, './src/page'),
    },
  },
})
