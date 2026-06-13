// Bundle de las dos Lambdas con esbuild.
// - format cjs, target node22 (igual que el runtime nodejs22.x)
// - @aws-sdk/* externo: lo provee el runtime de Lambda (no se bundlea)
// - @supabase/supabase-js SÍ se bundlea (no está en el runtime)
import { build } from 'esbuild'

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['@aws-sdk/*'],
  logLevel: 'info',
  sourcemap: false,
}

await build({ ...common, entryPoints: ['src/sender.ts'], outfile: 'dist/sender.js' })
await build({ ...common, entryPoints: ['src/webhook.ts'], outfile: 'dist/webhook.js' })
console.log('[build] dist/sender.js + dist/webhook.js listos')
