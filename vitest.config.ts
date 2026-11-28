import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))
const require = createRequire(import.meta.url)
const dependenciesRoot = realpathSync(resolve(root, 'node_modules'))
const testingLibraryDomRoot = realpathSync(dirname(require.resolve('@testing-library/dom/package.json')))

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
        const linkedDir = resolve(root, 'node_modules', ...name.split('/'))
        const info = {
          // Keep root-installed packages on their node_modules symlink path so
          // Vite resolves their ordinary peer/dev dependencies from this test graph.
          dir: existsSync(join(linkedDir, 'package.json')) ? linkedDir : dirname(file),
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
    resolveId(source: string, importer: string | undefined) {
      if (!source.startsWith('@deepseek-ai/')) return null
      const [scope, basename, ...parts] = source.split('/')
      const info = packageInfo(`${scope}/${basename}`, importer)
      if (!info) return null
      const key = parts.length ? `./${parts.join('/')}` : '.'
      if (key === './client' && basename === 'dsh-client-ui-renderer') {
        return existingFile(resolve(info.dir, 'src/client/index.ts'))
      }
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
  server: {
    fs: { allow: [root, dependenciesRoot, testingLibraryDomRoot] },
  },
  resolve: {
    dedupe: ['@deepseek-ai/cordis', 'react', 'react-dom'],
    preserveSymlinks: true,
    alias: {
      // Alias before Vite externalization as well as source resolution: every
      // Service/Context consumer must use this exact installed Cordis module.
      '@deepseek-ai/cordis': require.resolve('@deepseek-ai/cordis'),
      react: resolve(root, 'node_modules/react'),
      'react/jsx-runtime': resolve(root, 'node_modules/react/jsx-runtime.js'),
      'react/jsx-dev-runtime': resolve(root, 'node_modules/react/jsx-dev-runtime.js'),
      'react-dom': resolve(root, 'node_modules/react-dom'),
      'react-dom/client': resolve(root, 'node_modules/react-dom/client.js'),
      clsx: resolve(root, 'node_modules/clsx'),
      zustand: resolve(root, 'node_modules/zustand'),
      immer: resolve(root, 'node_modules/immer'),
      '@testing-library/dom': resolve(root, 'node_modules/@testing-library/dom'),
      '@deepseek-ai/dsh-client-runtime/client': resolve(root, 'repro/shims/client-runtime.ts'),
      '@deepseek-ai/dsh-client-runtime': resolve(root, 'repro/shims/client-runtime.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.spec.tsx'],
  },
})
