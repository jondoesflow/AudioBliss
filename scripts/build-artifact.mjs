// Builds a single-file version of the app (CSS and JS inlined) for publishing as a claude.ai Artifact.
// Usage: node scripts/build-artifact.mjs <out.html>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const inner = html.split('<!--AB:START-->')[1].split('<!--AB:END-->')[0];
const out = inner.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => '<script>\n' + readFileSync(resolve(root, src), 'utf8') + '\n</script>');
writeFileSync(process.argv[2] || resolve(root, 'dist/artifact.html'), out.trim() + '\n');
console.log('wrote', process.argv[2], out.length, 'bytes');
