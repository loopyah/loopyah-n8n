import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_SECONDS = 5 * 60;

interface Signed {
	body: string;
	id: string;
	signature: string;
	timestamp: string;
}

// Loopyah signs each send the Standard Webhooks way: an HMAC of the id, the time and the body, with the secret Loopyah
// gave when the trigger subscribed. A send that's old or signed with anything else didn't come from Loopyah.
export const isSignedByLoopyah = (
	secret: string,
	{ body, id, signature, timestamp }: Signed,
	now = Date.now(),
) => {
	const seconds = Number(timestamp);
	if (!id || !Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > TOLERANCE_SECONDS)
		return false;

	const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
	const expected = Buffer.from(
		createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64'),
	);

	return signature.split(' ').some((entry) => {
		const [version, value] = entry.split(',');
		const given = Buffer.from(value ?? '');
		return version === 'v1' && given.length === expected.length && timingSafeEqual(given, expected);
	});
};
