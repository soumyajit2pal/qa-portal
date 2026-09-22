import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function loadTypeScriptModule(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
}

function installStorage() {
  const values = new Map()
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
    },
  }
  return values
}

const preferences = await loadTypeScriptModule('../src/projectPreferences.ts')

test('project preferences are isolated per signed-in user', () => {
  installStorage()
  preferences.rememberLastProjectId(12, 101)
  preferences.rememberLastProjectId(29, 202)
  preferences.rememberFavoriteProjectIds(new Set([12, 14]), 101)
  preferences.rememberFavoriteProjectIds(new Set([29]), 202)

  assert.equal(preferences.readLastProjectId(101), 12)
  assert.equal(preferences.readLastProjectId(202), 29)
  assert.deepEqual([...preferences.readFavoriteProjectIds(101)], [12, 14])
  assert.deepEqual([...preferences.readFavoriteProjectIds(202)], [29])
})

test('project resolution honors links, current state, remembered state, then fallback', () => {
  installStorage()
  const projects = [{ id: 3 }, { id: 7 }, { id: 11 }]
  preferences.rememberLastProjectId(7, 44)

  assert.equal(preferences.resolvePreferredProjectId(projects, 11, 3, 44), 11)
  assert.equal(preferences.resolvePreferredProjectId(projects, null, 3, 44), 3)
  assert.equal(preferences.resolvePreferredProjectId(projects, null, '', 44), 7)
  assert.equal(preferences.resolvePreferredProjectId([{ id: 3 }], null, '', 44), 3)
  assert.equal(preferences.readLastProjectId(44), 7, 'automatic fallback must not replace the remembered project')
})

test('only an explicit project choice writes the preference', async () => {
  const source = await readFile(new URL('../src/components/ProjectSelect.tsx', import.meta.url), 'utf8')
  assert.match(source, /function selectProject[\s\S]*rememberLastProjectId\(nextProjectId, userId\)[\s\S]*onChange\(nextProjectId\)/)
  assert.doesNotMatch(source, /useEffect\(\(\) => \{\s*if \(value\) rememberLastProjectId/)
})

test('favorite project rows remain single-action listbox options', async () => {
  const source = await readFile(new URL('../src/components/SearchableSelect.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /onToggleFavorite|searchable-select-favorite-row/)
  assert.match(source, /role="option"[\s\S]*aria-selected=\{active\}/)
  assert.match(source, /searchable-select-group-label" role="presentation"/)
})

test('shared select triggers retain generic ellipsis styling', async () => {
  const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')
  assert.match(css, /\.searchable-select-trigger > span:first-child \{[^}]*display:block[^}]*text-overflow:ellipsis/s)
  assert.match(css, /\.searchable-select-trigger > \.searchable-select-trigger-value \{[^}]*display:flex/s)
})
