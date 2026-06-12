import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '../../')
const targets = [['public/icons/icon.svg', 'docs/public/icon.svg']]

for (const [src, dst] of targets) {
  const srcPath = resolve(root, src)
  const dstPath = resolve(root, dst)
  mkdirSync(dirname(dstPath), { recursive: true })
  copyFileSync(srcPath, dstPath)
  console.log(`synced ${src} -> ${dst}`)
}
