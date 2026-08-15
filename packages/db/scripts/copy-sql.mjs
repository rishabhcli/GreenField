// Copies the hand-written SQL migration files into dist/migrations so the
// compiled package can read them at runtime without a src/ directory present
// (tsc never touches .sql files, so this is a small manual build step rather
// than something the TypeScript compiler can do for us).
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const srcDir = join(root, 'src', 'migrations');
const outDir = join(root, 'dist', 'migrations');

if (!existsSync(srcDir)) {
  throw new Error(`copy-sql: source migrations directory does not exist: ${srcDir}`);
}
mkdirSync(outDir, { recursive: true });

const files = readdirSync(srcDir).filter((f) => f.endsWith('.sql'));
if (files.length === 0) {
  throw new Error(`copy-sql: no .sql files found in ${srcDir}`);
}
for (const file of files) {
  cpSync(join(srcDir, file), join(outDir, file));
}
console.log(`copy-sql: copied ${files.length} migration file(s) to ${outDir}`);
