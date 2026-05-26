import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'

const maxBridgeHelperLines = 300
const scriptsRoot = fileURLToPath(new URL('../agent-skill/stackprism-site-experience/scripts/', import.meta.url))

const collectBridgeScriptFiles = async dir => {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__pycache__') files.push(...(await collectBridgeScriptFiles(path)))
    } else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.py')) {
      files.push(path)
    }
  }
  return files
}

test('agent bridge helper source files stay within the plan line budget', async () => {
  const files = await collectBridgeScriptFiles(scriptsRoot)
  const oversized = []

  for (const file of files) {
    const lineCount = (await readFile(file, 'utf8')).split('\n').length
    if (lineCount > maxBridgeHelperLines) oversized.push(`${file}: ${lineCount}`)
  }

  assert.deepEqual(oversized, [])
})
