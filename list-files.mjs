// Writes files.json: every lesson file with its size, for the offline download script.
// Run before each deploy:  node list-files.mjs && npx wrangler deploy
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push([p.split('\\').join('/'), statSync(p).size]);
  }
})('LESSONS');
for (const name of readdirSync('SWF')) files.push(['SWF/' + name, statSync(join('SWF', name)).size]);
writeFileSync('files.json', JSON.stringify(files));
console.log(`files.json: ${files.length} files, ${(files.reduce((s, f) => s + f[1], 0) / 1e9).toFixed(2)} GB`);
