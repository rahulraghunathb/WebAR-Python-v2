// Embed a wasm binary as a base64 constant inside a JS module: replaces the
// line `const <NAME> = '...'` (or appends it if missing).
//   node tools/embed-kernel.mjs build/lk.wasm static/sdk/vision/lk-kernel.js LK_KERNEL_B64
import { readFileSync, writeFileSync } from 'node:fs'

const [wasmPath, jsPath, name] = process.argv.slice(2)
if (!wasmPath || !jsPath || !name) {
    console.error('usage: node tools/embed-kernel.mjs <wasm> <js> <CONST_NAME>')
    process.exit(2)
}
const b64 = readFileSync(wasmPath).toString('base64')
let js = readFileSync(jsPath, 'utf8')
const re = new RegExp(`const ${name} = '[^']*'`)
if (!re.test(js)) {
    console.error(`no "const ${name} = '...'" line found in ${jsPath}`)
    process.exit(2)
}
js = js.replace(re, `const ${name} = '${b64}'`)
writeFileSync(jsPath, js)
console.log(`embedded ${wasmPath} (${b64.length} b64 chars) into ${jsPath}`)
