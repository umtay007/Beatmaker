// Build the web app (../dist) and copy it into app/, which the desktop shell serves.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
execSync('npm run build', { cwd: root, stdio: 'inherit' });
const out = path.join(here, 'app');
rmSync(out, { recursive: true, force: true });
cpSync(path.join(root, 'dist'), out, { recursive: true });
if (!existsSync(path.join(out, 'index.html'))) throw new Error('The web build has no index.html');
console.log('Copied the web app into', out);
