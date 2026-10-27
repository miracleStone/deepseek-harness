import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin, vitestExecArgv } from '../../vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'], loose: true }), standardDecoratorPlugin()],
  resolve: { alias: {
    zod: fileURLToPath(new URL('../../packages/storage/storage-domain/node_modules/zod/index.js', import.meta.url)),
    react: fileURLToPath(new URL('../../packages/client/ui-model-selection/node_modules/react', import.meta.url)),
    'react-dom': fileURLToPath(new URL('../../packages/client/ui-model-selection/node_modules/react-dom', import.meta.url)),
  } },
  test: {
    include: ['local-plugins/session-fast/tests/**/*.spec.ts'],
    setupFiles: ['./scripts/test-proxy-environment.ts', './scripts/test-dom-environment.ts'],
    execArgv: vitestExecArgv,
    pool: 'forks',
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
