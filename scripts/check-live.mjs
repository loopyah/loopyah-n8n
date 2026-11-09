import { readFile } from 'node:fs/promises';

const LIVE = "const API_URL = 'https://api.loopyah.com';";
const source = await readFile(new URL('../credentials/LoopyahOAuth2Api.credentials.ts', import.meta.url), 'utf8');

if (!source.includes(LIVE)) {
	console.error('The credential still points at the dev API. Set API_URL to https://api.loopyah.com before publishing.');
	process.exit(1);
}
