/**
 * The verify-cordis-config metadata contract: `disabled` is the one entry
 * metadata field whose `!!js` expression the Loader interpolates; every other
 * metadata field must stay static, and a disabled expression must parse.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cordisConfigFiles } from './cordis-config-files.ts'
import {
  bundleManifestPaths,
  bundlePluginDependencyErrors,
  exclusivePlaneRowIds,
  metadataExpressionErrors,
  packageTestFixtureDependencyErrors,
  packageTestPluginDependencyErrors,
  readCordisConfig,
} from './verify-cordis-config.ts'

describe('Loader configuration aliases', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function fixture(): { root: string; file(path: string, source: string): void } {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cordis-alias-'))
    roots.push(root)
    return {
      root,
      file(path, source) {
        const target = join(root, path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, source)
      },
    }
  }

  it('reads a tracked symlink placeholder without excluding its canonical config from discovery', () => {
    const f = fixture()
    f.file('apps/cordis.yml', '../snapshots/cordis.yml')
    f.file('snapshots/cordis.yml', '- id: shared\n  name: plugin\n')
    expect(readCordisConfig(f.root, 'apps/cordis.yml', new Set(['apps/cordis.yml'])))
      .toEqual([{ id: 'shared', name: 'plugin' }])
    expect(cordisConfigFiles(f.root).map(file => file.replaceAll('\\', '/')))
      .toEqual(['apps/cordis.yml', 'snapshots/cordis.yml'])
  })

  it('follows a chain of tracked symlink placeholders', () => {
    const f = fixture()
    f.file('cordis.yml', 'alias.cordis.yml')
    f.file('alias.cordis.yml', 'target.cordis.yml')
    f.file('target.cordis.yml', '[]\n')
    expect(readCordisConfig(f.root, 'cordis.yml', new Set(['cordis.yml', 'alias.cordis.yml']))).toEqual([])
  })

  it('leaves an ordinary path-like YAML scalar invalid instead of treating it as an alias', () => {
    const f = fixture()
    f.file('cordis.yml', 'target.cordis.yml')
    f.file('target.cordis.yml', '[]\n')
    const document = readCordisConfig(f.root, 'cordis.yml', new Set())
    expect(document).toBe('target.cordis.yml')
    expect(Array.isArray(document)).toBe(false)
  })

  it('preserves a malformed scalar target for rejection through both its alias and canonical path', () => {
    const f = fixture()
    f.file('cordis.yml', 'target.cordis.yml')
    f.file('target.cordis.yml', 'not-an-entry-array\n')
    const tracked = new Set(['cordis.yml'])
    for (const file of ['cordis.yml', 'target.cordis.yml']) {
      expect(readCordisConfig(f.root, file, tracked)).toBe('not-an-entry-array')
    }
  })

  it('rejects a tracked alias cycle with the original configuration path', () => {
    const f = fixture()
    f.file('cordis.yml', 'alias.cordis.yml')
    f.file('alias.cordis.yml', 'cordis.yml')
    expect(() => readCordisConfig(f.root, 'cordis.yml', new Set(['cordis.yml', 'alias.cordis.yml'])))
      .toThrow('cordis.yml: configuration alias cycle')
  })

  it.each(['relative', 'absolute'] as const)('rejects %s alias targets outside the repository', (form) => {
    const f = fixture()
    f.file('cordis.yml', form === 'relative' ? '../outside.cordis.yml' : join(f.root, '..', 'outside.cordis.yml'))
    expect(() => readCordisConfig(f.root, 'cordis.yml', new Set(['cordis.yml'])))
      .toThrow('cordis.yml: configuration alias target must remain inside the repository')
  })

  it('preserves a missing alias target error', () => {
    const f = fixture()
    f.file('cordis.yml', 'missing.cordis.yml')
    expect(() => readCordisConfig(f.root, 'cordis.yml', new Set(['cordis.yml'])))
      .toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })

  it.skipIf(process.platform === 'win32')('reads a native file symlink (creation requires privileges on Windows)', () => {
    const f = fixture()
    f.file('target.cordis.yml', '[]\n')
    symlinkSync('target.cordis.yml', join(f.root, 'cordis.yml'))
    expect(readCordisConfig(f.root, 'cordis.yml', new Set(['cordis.yml']))).toEqual([])
  })
})

describe('verify-cordis-config metadata expressions', () => {
  it('accepts a disabled !!js expression', () => {
    const problems = metadataExpressionErrors(
      { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: { __jsExpr: "process.platform === 'win32'" } },
      '[0]',
    )
    expect(problems).toEqual([])
  })

  it('rejects an expression in a static metadata field', () => {
    const problems = metadataExpressionErrors({ id: { __jsExpr: 'process.platform' }, name: 'pkg' }, '[0]')
    expect(problems).toContain('[0].id: !!js is not interpolated here')
  })

  it('rejects an expression nested below disabled (only the field itself interpolates)', () => {
    const problems = metadataExpressionErrors(
      { id: 'tool-bash', name: 'pkg', disabled: { when: { __jsExpr: 'process.platform' } } },
      '[0]',
    )
    expect(problems).toContain('[0].disabled.when: !!js is not interpolated here')
  })

  it('rejects a disabled expression that does not parse (the loader would fail the boot)', () => {
    const problems = metadataExpressionErrors(
      { id: 'tool-bash', name: 'pkg', disabled: { __jsExpr: 'process.platform ===' } },
      '[0]',
    )
    expect(problems.some(problem => problem.includes('[0].disabled: disabled expression does not parse'))).toBe(true)
  })
})

describe('workspace Bundle discovery and product dependency closures', () => {
  it('allows scoped executors on both planes while retaining other plugin rows', () => {
    expect([...exclusivePlaneRowIds([{ insert: [
      { id: 'native', name: '@deepseek-ai/dsh-tool-executor-native' },
      { id: 'ptc', name: '@deepseek-ai/dsh-tool-executor-ptc' },
      { id: 'tools', name: '@deepseek-ai/dsh-tools' },
      { id: 'group', name: 'cordis:group', group: true, config: [
        { id: 'tool-executor-ptc', name: '@deepseek-ai/dsh-tool-fs' },
      ] },
    ] }])]).toEqual(['tools', 'group', 'tool-executor-ptc'])
  })

  it('discovers a Bundle outside packages/bundle from its manifest declaration', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-bundle-discovery-'))
    try {
      const bundleDir = join(fixture, 'packages/subagent/example')
      const plainDir = join(fixture, 'packages/bundle/plain')
      mkdirSync(bundleDir, { recursive: true })
      mkdirSync(plainDir, { recursive: true })
      writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh-subagent-example',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }))
      writeFileSync(join(plainDir, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh-plain',
      }))

      expect(bundleManifestPaths(fixture)).toEqual([
        'packages/subagent/example/package.json',
      ])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('allows a Bundle to mount itself but rejects an undeclared plugin package', () => {
    const manifestPath = 'packages/subagent/example/package.json'
    const file = 'packages/subagent/example/cordis.patch.yml'
    const manifest = {
      name: '@deepseek-ai/dsh-subagent-example',
      dependencies: {},
    }
    const self = { file, name: '@deepseek-ai/dsh-subagent-example' }
    expect(bundlePluginDependencyErrors(manifestPath, manifest, [self])).toEqual([])
    expect(bundlePluginDependencyErrors(manifestPath, {
      ...manifest, optionalDependencies: { '@deepseek-ai/dsh-platform-plugin': 'workspace:*' },
    }, [{ file, name: '@deepseek-ai/dsh-platform-plugin' }])).toEqual([])
    expect(bundlePluginDependencyErrors(manifestPath, manifest, [
      self,
      { file, name: '@deepseek-ai/dsh-missing-plugin' },
    ])).toEqual([
      `${file}: @deepseek-ai/dsh-missing-plugin must be declared in ${manifestPath} dependencies or optionalDependencies`,
    ])
  })
})

describe('package-owned Loader test dependency closures', () => {
  it('requires package test configs to declare each named plugin they load', () => {
    const manifestPath = 'packages/example/owner/package.json'
    const file = 'packages/example/owner/tests/fixtures/cordis.yml'
    const manifest = {
      name: '@deepseek-ai/dsh-owner',
      dependencies: {},
      devDependencies: {
        '@deepseek-ai/dsh-declared': 'workspace:^',
      },
    }
    expect(packageTestPluginDependencyErrors(manifestPath, manifest, [
      { file, name: '@deepseek-ai/dsh-owner' },
      { file, name: '@deepseek-ai/dsh-declared' },
      { file, name: '@deepseek-ai/dsh-missing' },
    ])).toEqual([
      `${file}: @deepseek-ai/dsh-missing must be declared in ${manifestPath} dependencies or devDependencies`,
    ])
  })

  it('requires executable package test fixtures to declare their bare imports', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-package-test-entrypoint-'))
    try {
      const packageDir = join(fixture, 'packages/example/owner')
      const driverDir = join(packageDir, 'tests/fixtures/loader')
      mkdirSync(driverDir, { recursive: true })
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh-owner',
        devDependencies: {
          '@deepseek-ai/dsh-declared': 'workspace:^',
        },
      }))
      writeFileSync(join(driverDir, 'driver.ts'), [
        "import '@deepseek-ai/dsh-owner'",
        "import '@deepseek-ai/dsh-declared'",
        "import '@deepseek-ai/dsh-missing'",
      ].join('\n'))
      writeFileSync(join(driverDir, 'cordis.yml'), '[]\n')
      writeFileSync(join(driverDir, 'fixture.mjs'), "import '@deepseek-ai/dsh-declared'\n")
      const unrelatedDir = join(packageDir, 'tests/fixtures/unrelated')
      mkdirSync(unrelatedDir, { recursive: true })
      writeFileSync(join(unrelatedDir, 'driver.ts'), "import '@deepseek-ai/dsh-unrelated'\n")

      expect(packageTestFixtureDependencyErrors(fixture)).toEqual([
        'packages/example/owner/tests/fixtures/loader/driver.ts: '
        + '@deepseek-ai/dsh-missing must be declared in '
        + 'packages/example/owner/package.json dependencies or devDependencies',
      ])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('fails loud when package-owned Loader fixtures disappear from the scan', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-empty-package-test-entrypoint-'))
    try {
      expect(packageTestFixtureDependencyErrors(fixture)).toEqual([
        'package test fixture dependency scan found no package-owned Loader configs',
      ])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
