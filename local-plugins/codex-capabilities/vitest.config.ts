import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin, vitestExecArgv } from '../../vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'], loose: true }), standardDecoratorPlugin()],
  test: {
    include: ['local-plugins/codex-capabilities/tests/**/*.spec.{ts,js}'],
    setupFiles: ['./scripts/test-proxy-environment.ts'],
    execArgv: vitestExecArgv,
    pool: 'forks',
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
