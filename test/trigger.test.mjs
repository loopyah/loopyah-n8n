import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const { LoopyahTrigger } = require('../dist/nodes/Loopyah/LoopyahTrigger.node.js');
const { LoopyahOAuth2Api } = require('../dist/credentials/LoopyahOAuth2Api.credentials.js');

const API = 'https://api.test';
const trigger = new LoopyahTrigger();

const order = (id, paidAt) => ({ id, paymentSucceededAt: paidAt, amountCents: 2500 });

// A stand-in for n8n that answers Loopyah requests from the given pages and records each request.
const n8n = ({ event = 'order', organizer = '', mode = 'trigger', state = {}, pages = [] }) => {
	const requests = [];
	return {
		requests,
		state,
		getNodeParameter: (name, fallback) => ({ event, organizer })[name] ?? fallback,
		getWorkflowStaticData: () => state,
		getMode: () => mode,
		getCredentials: async () => ({ serverUrl: API }),
		getNode: () => ({ id: '1', name: 'Loopyah Trigger', type: 'loopyahTrigger', typeVersion: 1, position: [0, 0], parameters: {} }),
		helpers: {
			returnJsonArray: (rows) => rows.map((json) => ({ json })),
			httpRequestWithAuthentication: async (credential, options) => {
				requests.push({ credential, ...options });
				const index = options.qs.pageParam ?? options.qs.page - 1;
				return { data: pages[index] ?? [] };
			},
		},
	};
};

const poll = (context) => trigger.poll.call(context);
const ids = (result) => result[0].map((item) => item.json.id ?? item.json.ticket?.id);

describe('sign-in', () => {
	test('turns on self-registration and points at Loopyah, with nothing for the organiser to fill in', () => {
		const credential = new LoopyahOAuth2Api();
		assert.deepEqual(credential.extends, ['oAuth2Api']);
		const fields = Object.fromEntries(credential.properties.map((p) => [p.name, p]));
		assert.equal(fields.useDynamicClientRegistration.default, true);
		assert.match(fields.serverUrl.default, /^https:\/\/api(-dev)?\.loopyah\.com$/);
		assert.ok(credential.properties.every((p) => p.type === 'hidden'));
	});
});

describe('Loopyah Trigger', () => {
	test('switching on starts from the newest record without replaying history', async () => {
		const context = n8n({ pages: [[order('o2', '2026-11-09T10:00:00Z'), order('o1', '2026-11-09T09:00:00Z')]] });
		assert.equal(await poll(context), null);
		assert.equal(context.state.watching, 'order:');
	});

	test('starts a run for each new record, oldest first, and not again on the next poll', async () => {
		const context = n8n({ pages: [[order('o2', '2026-11-09T10:00:00Z')]] });
		await poll(context);

		context.helpers.httpRequestWithAuthentication = async (_c, options) => ({
			data: options.qs.pageParam === 0 ? [order('o4', '2026-11-09T12:00:00Z'), order('o3', '2026-11-09T11:00:00Z'), order('o2', '2026-11-09T10:00:00Z')] : [],
		});
		assert.deepEqual(ids(await poll(context)), ['o3', 'o4']);
		assert.equal(await poll(context), null);
	});

	test('a record sharing the last time is new only if its ID was not seen', async () => {
		const same = '2026-11-09T10:00:00Z';
		const context = n8n({ pages: [[order('a', same)]] });
		await poll(context);

		context.helpers.httpRequestWithAuthentication = async () => ({ data: [order('b', same), order('a', same)] });
		assert.deepEqual(ids(await poll(context)), ['b']);
		assert.equal(await poll(context), null);
	});

	test('when the list was empty on switching on, every later record is new', async () => {
		const context = n8n({ pages: [[]] });
		assert.equal(await poll(context), null);

		context.helpers.httpRequestWithAuthentication = async (_c, options) => ({
			data: options.qs.pageParam === 0 ? [order('o1', '2026-11-09T10:00:00Z')] : [],
		});
		assert.deepEqual(ids(await poll(context)), ['o1']);
	});

	test('reads further pages until it reaches a record it has seen', async () => {
		const page = (start) => Array.from({ length: 20 }, (_, i) => order(`p${start + i}`, new Date(Date.UTC(2026, 10, 9, 12, 0, 0) - (start + i) * 1000).toISOString()));
		const context = n8n({ state: { watching: 'order:', lastTime: Date.parse(page(30)[0].paymentSucceededAt), idsAtLastTime: ['p30'] }, pages: [page(0), page(20), page(40)] });

		const result = await poll(context);
		assert.equal(result[0].length, 30);
		assert.equal(context.requests.length, 2);
	});

	test('reads at most five pages in one poll', async () => {
		const full = Array.from({ length: 20 }, (_, i) => order(`x${i}`, '2026-11-09T12:00:00Z'));
		const context = n8n({ state: { watching: 'order:', lastTime: 0, idsAtLastTime: [] }, pages: Array(9).fill(full) });
		await poll(context);
		assert.equal(context.requests.length, 5);
	});

	test('testing in the editor returns the latest record and leaves what the trigger remembers alone', async () => {
		const state = { watching: 'order:', lastTime: 1, idsAtLastTime: ['old'] };
		const context = n8n({ mode: 'manual', state, pages: [[order('o9', '2026-11-09T12:00:00Z'), order('o8', '2026-11-09T11:00:00Z')]] });
		assert.deepEqual(ids(await poll(context)), ['o9']);
		assert.deepEqual(state, { watching: 'order:', lastTime: 1, idsAtLastTime: ['old'] });
	});

	test('changing the trigger or organizer starts fresh', async () => {
		const context = n8n({ event: 'order', organizer: 'org_2', state: { watching: 'order:', lastTime: 5, idsAtLastTime: ['x'] }, pages: [[]] });
		assert.equal(await poll(context), null);
		assert.deepEqual(context.state, { watching: 'order:org_2' });
	});

	test('sends the organizer only when one is picked, with the connection attached', async () => {
		const mine = n8n({ pages: [[]] });
		await poll(mine);
		assert.deepEqual(mine.requests[0], { credential: 'loopyahOAuth2Api', method: 'GET', url: `${API}/data/creator-ticket-orders`, qs: { pageParam: 0 }, json: true });

		const theirs = n8n({ organizer: 'org_2', pages: [[]] });
		await poll(theirs);
		assert.deepEqual(theirs.requests[0].qs, { pageParam: 0, creator: 'org_2' });
	});

	test('contacts page from 1 and sit inside the page', async () => {
		const context = n8n({ event: 'contact', mode: 'manual' });
		context.helpers.httpRequestWithAuthentication = async (_c, options) => {
			context.requests.push(options);
			return { data: { contacts: [{ id: 'c1', createdAt: '2026-11-09T10:00:00Z' }] } };
		};
		assert.deepEqual(ids(await poll(context)), ['c1']);
		assert.deepEqual(context.requests[0].qs, { page: 1 });
	});

	test('check-ins use the scan time, or the hand check-in time when there was no scan', async () => {
		const checkIn = (id, scannedAt, checkedInAt) => ({ ticket: { id, scannedAt, checkedInAt } });
		const context = n8n({ event: 'checkIn', state: { watching: 'checkIn:', lastTime: Date.parse('2026-11-09T10:00:00Z'), idsAtLastTime: ['t0'] } });
		context.helpers.httpRequestWithAuthentication = async () => ({
			data: [checkIn('t2', null, '2026-11-09T12:00:00Z'), checkIn('t1', '2026-11-09T11:00:00Z', null), checkIn('t0', '2026-11-09T10:00:00Z', null)],
		});
		assert.deepEqual(ids(await poll(context)), ['t1', 't2']);
	});

	test('payouts take their ID and paid time from whichever payout they are', async () => {
		const context = n8n({ event: 'payout', state: { watching: 'payout:', lastTime: Date.parse('2026-11-09T10:00:00Z'), idsAtLastTime: [] } });
		context.helpers.httpRequestWithAuthentication = async () => ({
			data: [
				{ source: 'pos', posPayout: { id: 'pp1', transferredAt: '2026-11-09T12:00:00Z' } },
				{ source: 'ticket', ticketPayout: { id: 'tp1', statusChangedAt: '2026-11-09T11:00:00Z' } },
				{ source: 'sponsorship', sponsorshipPayout: { id: 'sp0', transferredAt: '2026-11-09T09:00:00Z' } },
			],
		});
		const result = await poll(context);
		assert.deepEqual(result[0].map((i) => i.json.source), ['ticket', 'pos']);
		assert.equal(context.state.idsAtLastTime[0], 'pp1');
	});

	test('a refusal from Loopyah fails the poll with Loopyah\'s message', async () => {
		const context = n8n({});
		context.helpers.httpRequestWithAuthentication = async () => {
			throw Object.assign(new Error('Request failed with status code 403'), { httpCode: '403', description: 'You need a team role that can read orders' });
		};
		await assert.rejects(poll(context), (error) => error.constructor.name === 'NodeApiError');
	});

	test('the organizer list offers your own account first, then each team you are on', async () => {
		const context = n8n({});
		context.helpers.httpRequestWithAuthentication = async (_c, options) => {
			assert.equal(options.url, `${API}/data/my-teams`);
			return { data: [{ creator: { id: 'org_2', name: 'Night Market' } }] };
		};
		const options = await trigger.methods.loadOptions.getOrganizers.call(context);
		assert.deepEqual(options, [{ name: 'My Account', value: '' }, { name: 'Night Market', value: 'org_2' }]);
	});
});
