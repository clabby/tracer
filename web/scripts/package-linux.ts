#!/usr/bin/env bun

import { $ } from 'bun'
import { chmod, cp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const webDir = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(webDir, 'native')

const targets = [
  {
    artifact: 'tracer-linux-amd64',
    bunTarget: 'bun-linux-x64-baseline',
  },
  {
    artifact: 'tracer-linux-arm64',
    bunTarget: 'bun-linux-arm64',
  },
] as const

process.chdir(webDir)

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

await $`bun run build`
await $`sh -c ${'if [ -d dist/assets ]; then find dist/assets -type f ! -name "*.gz" -exec gzip -k -9 {} +; fi'}`

for (const target of targets) {
  const packageDir = join(outDir, target.artifact)
  const binDir = join(packageDir, 'bin')
  const libexecDir = join(packageDir, 'libexec')
  const wrapper = join(binDir, 'tracer')
  const binary = join(libexecDir, 'tracer')
  const compiled = join(webDir, `.tracer-${target.artifact}`)

  await mkdir(binDir, { recursive: true })
  await mkdir(libexecDir, { recursive: true })
  await rm(compiled, { force: true })
  await $`bun build --compile --target=${target.bunTarget} --minify --outfile=${compiled} server/index.ts`
  await rename(compiled, binary)
  await chmod(binary, 0o755)
  await writeFile(
    wrapper,
    `#!/bin/sh
set -eu

bin_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
STATIC_DIR=\${STATIC_DIR:-"$bin_dir/../dist"}
export STATIC_DIR

exec "$bin_dir/../libexec/tracer" "$@"
`,
  )
  await chmod(wrapper, 0o755)
  await cp('dist', join(packageDir, 'dist'), { recursive: true })
  await writeFile(
    join(packageDir, 'README.md'),
    `# ${target.artifact}

Run tracer with:

\`\`\`sh
TEMPO_URL=https://tempo.example.com bin/tracer
\`\`\`

\`bin/tracer\` sets \`STATIC_DIR\` to the bundled React SPA in \`dist/\` and
then execs the compiled server binary in \`libexec/tracer\`. Set \`STATIC_DIR\`
if you move the executable or UI bundle.
`,
  )

  await $`find ${packageDir} -name '._*' -exec rm -f {} +`
  await $`env COPYFILE_DISABLE=1 tar -czf ${join(outDir, `${target.artifact}.tar.gz`)} -C ${outDir} ${target.artifact}`
}

console.log(`wrote ${targets.map((target) => `native/${target.artifact}.tar.gz`).join(', ')}`)
