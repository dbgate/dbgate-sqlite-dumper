import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'better-sqlite3': 'src/better-sqlite3.ts',
    d1: 'src/d1.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  skipNodeModulesBundle: true,
  splitting: false,
});
