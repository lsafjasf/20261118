#!/usr/bin/env node
// Compiles the hand-written WebAssembly text module (src/declicker.wat)
// into build/declicker.wasm using the wabt npm package (no native
// toolchain / emscripten required).
const fs = require('node:fs');
const path = require('node:path');
const wabtInit = require('wabt');

async function main() {
  const root = path.resolve(__dirname, '..');
  const watPath = path.join(root, 'src', 'declicker.wat');
  const outPath = path.join(root, 'build', 'declicker.wasm');
  const wabt = await wabtInit();
  const text = fs.readFileSync(watPath, 'utf8');
  const module = wabt.parseWat('declicker.wat', text);
  module.resolveNames();
  module.validate();
  const { buffer } = module.toBinary({ log: false, write_debug_names: false });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(buffer));
  console.log(`built ${path.relative(root, outPath)} (${buffer.length} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
