import { readFile } from 'node:fs/promises';

const LIVE = "const API_URL = 'https://api.loopyah.com';";
const source = await readFile(new URL('../nodes/Loopyah/api.ts', import.meta.url), 'utf8');

if (!source.includes(LIVE)) {
	console.error('The package still points at the dev API. Set API_URL in nodes/Loopyah/api.ts to https://api.loopyah.com before publishing.');
	process.exit(1);
}
