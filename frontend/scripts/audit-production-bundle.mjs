import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'
import process from 'node:process'

const root = resolve(process.cwd(), 'dist')
const forbiddenFiles = new Set(['.DS_Store', 'Thumbs.db'])
const forbiddenExtensions = new Set(['.map', '.ts', '.tsx'])
const forbiddenText = [
  ['source map reference', /sourceMappingURL=/i],
  ['development runtime', /(?:@vite\/client|react-refresh|__vite_plugin_react_preamble_installed__)/i],
  // React Router internally uses bare http://localhost as an inert URL base;
  // reject only an address that could actually target a development API.
  ['development API host', /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+|\/api)/i],
  ['retired workspace compatibility API', /\/api\/qa-workspaces(?:[/?"'`]|$)/i],
  ['retired repository bulk API', /\/projects\/[^/"'`]+\/test-cases\/all(?:[?"'`]|$)/i],
  ['retired execution case-id API', /\/cycles\/[^/"'`]+\/executions\/case-ids(?:[?"'`]|$)/i],
  ['retired sign-off API', /\/department-head-coe-decision(?:[?"'`]|$)/i],
]

// Every API family intentionally consumed by the browser must be listed.
// This does not make route names secret; it prevents an accidental debug,
// test, deprecated, or unrelated backend family from silently entering a
// production bundle during a future change.
const allowedApiFamilies = new Set([
  'application-names', 'applications', 'approvals', 'audit', 'auth', 'checklist-config',
  'dashboard', 'dast-requests', 'defects', 'departments', 'document-portal',
  'export', 'functional-requests', 'jobs', 'pending-approvals',
  'performance-requests', 'qa-requests', 'reports', 'request-type-config',
  'sast-requests', 'signoffs', 'suppressions', 'test-execution',
  'test-projects', 'test-reports', 'test-repository', 'workspaces',
])

async function filesBelow(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) output.push(...await filesBelow(path))
    else output.push(path)
  }
  return output
}

const failures = []
const apiFamilies = new Set()
let files
try {
  files = await filesBelow(root)
} catch (error) {
  throw new Error(`Production bundle is missing or unreadable: ${error.message}`)
}

for (const path of files) {
  const name = path.split(sep).at(-1)
  const display = relative(root, path)
  if (forbiddenFiles.has(name) || name.startsWith('.')) failures.push(`${display}: metadata/dotfile`)
  if (forbiddenExtensions.has(extname(name))) failures.push(`${display}: source/development artifact`)
  if (!['.js', '.css', '.html', '.json', '.webmanifest'].includes(extname(name))) continue
  const content = await readFile(path, 'utf8')
  for (const [label, pattern] of forbiddenText) {
    if (pattern.test(content)) failures.push(`${display}: ${label}`)
  }
  for (const match of content.matchAll(/\/api\/([a-z][a-z0-9-]*)/g)) apiFamilies.add(match[1])
}

for (const family of apiFamilies) {
  if (!allowedApiFamilies.has(family)) failures.push(`unreviewed client API family: /api/${family}`)
}

if (failures.length) {
  console.error('Production bundle security audit failed:')
  for (const failure of [...new Set(failures)].sort()) console.error(`- ${failure}`)
  process.exit(1)
}

const totalBytes = (await Promise.all(files.map(async (path) => (await stat(path)).size)))
  .reduce((sum, size) => sum + size, 0)
console.log(`Production bundle security audit passed: ${files.length} files, ${totalBytes} bytes, ${apiFamilies.size} reviewed API families.`)
