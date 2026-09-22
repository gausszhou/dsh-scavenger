import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  outDir: 'lib',
  dts: { entry: ['src/index.ts'] },
  sourcemap: false,
})