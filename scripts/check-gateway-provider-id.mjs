import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const rustPath = path.join(root, 'src-tauri', 'src', 'constants.rs')
const uiPath = path.join(root, 'src', 'ui', 'constants.ts')

const rustText = fs.readFileSync(rustPath, 'utf8')
const uiText = fs.readFileSync(uiPath, 'utf8')

const rustMatch = rustText.match(
  /pub const GATEWAY_MODEL_PROVIDER_ID:\s*&str\s*=\s*"([^"]+)"/
)
const uiMatch = uiText.match(
  /export const GATEWAY_MODEL_PROVIDER_ID\s*=\s*'([^']+)'/
)

if (!rustMatch) {
  console.error(`Cannot parse Rust constant from ${rustPath}`)
  process.exit(1)
}
if (!uiMatch) {
  console.error(`Cannot parse UI constant from ${uiPath}`)
  process.exit(1)
}

if (rustMatch[1] !== uiMatch[1]) {
  console.error(
    `GATEWAY_MODEL_PROVIDER_ID mismatch: Rust=${rustMatch[1]} UI=${uiMatch[1]}`
  )
  process.exit(1)
}
