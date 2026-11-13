import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))
const require = createRequire(import.meta.url)

type ExportTarget = string | { [condition: string]: ExportTarget } | null
interface PackageManifest {
  exports?: Record<string, ExportTarget>
}

function existingFile(base: string): string | null {
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/**
 * Published client bundles register with the host's module loader. Tests use
 * the source shipped beside those bundles, located through package exports
 * rather than a sibling Harness checkout or pnpm's installation layout.
 */
function harnessSourcesPlugin(): Plugin {
  const packages = new Map<string, { dir: string; manifest: PackageManifest }>()

  function packageInfo(name: string, importer?: string) {
    const cached = packages.get(name)
    if (cached) return cached
    // Prefer the project's dependency; fall back to a transitive dependency's
    // own resolver. Cache by name so all consumers share the same module graph.
    for (const resolver of [require, ...(importer ? [createRequire(importer)] : [])]) {
      try {
        const file = resolver.resolve(`${name}/package.json`)
        const info = {
          dir: dirname(file),
          manifest: JSON.parse(readFileSync(file, 'utf8')) as PackageManifest,
        }
        packages.set(name, info)
        return info
      } catch {
        // Another resolver may own this package.
      }
    }
    return null
  }

  function sourceTarget(dir: string, target: ExportTarget | undefined): string | null {
    if (target == null) return null
    if (typeof target === 'object') {
      // Declaration outputs retain the source directory shape, including
      // ./client -> src/client/index.ts (not src/client.ts in every package).
      for (const condition of ['types', 'import', 'default']) {
        if (!(condition in target)) continue
        const hit = sourceTarget(dir, target[condition])
        if (hit) return hit
      }
      return null
    }
    const source = target
      .replace(/^\.\/lib\/types\//, './src/')
      .replace(/^\.\/lib\//, './src/')
      .replace(/\.d\.[cm]?ts$/, '')
      .replace(/\.[cm]?js$/, '')
    return source.startsWith('./src/') ? existingFile(resolve(dir, source)) : null
  }

  return {
    name: 'harness-published-sources',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!source.startsWith('@deepseek-ai/')) return null
      const [scope, basename, ...parts] = source.split('/')
      const info = packageInfo(`${scope}/${basename}`, importer)
      if (!info) return null
      const key = parts.length ? `./${parts.join('/')}` : '.'
      const exports = info.manifest.exports
      if (!exports) return null
      if (key in exports) return sourceTarget(info.dir, exports[key])
      for (const [pattern, target] of Object.entries(exports)) {
        const star = pattern.indexOf('*')
        if (star < 0 || typeof target !== 'string') continue
        const prefix = pattern.slice(0, star)
        const suffix = pattern.slice(star + 1)
        if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue
        const captured = key.slice(prefix.length, suffix ? -suffix.length : undefined)
        return sourceTarget(info.dir, target.replaceAll('*', captured))
      }
      return null
    },
  }
}

export default defineConfig({
  root,
  plugins: [harnessSourcesPlugin()],
  resolve: {
    dedupe: ['@deepseek-ai/cordis', 'react', 'react-dom'],
    alias: {
      // Alias before Vite externalization as well as source resolution: every
      // Service/Context consumer must use this exact installed Cordis module.
      '@deepseek-ai/cordis': require.resolve('@deepseek-ai/cordis'),
      react: resolve(root, 'node_modules/react'),
      'react/jsx-runtime': resolve(root, 'node_modules/react/jsx-runtime.js'),
      'react/jsx-dev-runtime': resolve(root, 'node_modules/react/jsx-dev-runtime.js'),
      'react-dom': resolve(root, 'node_modules/react-dom'),
      'react-dom/client': resolve(root, 'node_modules/react-dom/client.js'),
      '@deepseek-ai/dsh-client-runtime/client': resolve(root, 'repro/shims/client-runtime.ts'),
      '@deepseek-ai/dsh-client-runtime': resolve(root, 'repro/shims/client-runtime.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.spec.tsx'],
  },
})
