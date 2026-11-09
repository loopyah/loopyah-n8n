import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const { LoopyahTrigger } = require('../dist/nodes/Loopyah/LoopyahTrigger.node.js');
const { LoopyahOAuth2Api } = require('../dist/credentials/LoopyahOAuth2Api.credentials.js');
const { API_URL: API } = require('../dist/nodes/Loopyah/api.js');
const { NodeApiError } = require('n8n-workflow');

// What a credential would hold if someone changed its hidden server URL. The trigger must ignore it.
const ELSEWHERE = 'https://elsewhere.example';
const trigger = new LoopyahTrigger();

const order = (id, paidAt) => ({ id, paymentSucceededAt: paidAt, amountCents: 2500 });
const at = (iso) => Date.parse(iso);

// What a trigger remembers, for the given account, trigger and organizer, after seeing these records.
const watched = (event = 'order', organizer = '', account = 'acc1') => `${account}:${event}:${organizer}`;
const memory = (seen, event, organizer) => ({
	watching: watched(event, organizer),
	newest: Math.max(...Object.values(seen)),
	seen,
});

// A stand-in for n8n that answers Loopyah requests from the given pages and records each request.
const n8n = ({ event = 'order', organizer = '', account = 'acc1', mode = 'trigger', state = {}, pages = [] }) => {
	const requests = [];
	return {
		requests,
		state,
		getNodeParameter: (name, fallback) => ({ event, organizer })[name] ?? fallback,
		getWorkflowStaticData: () => state,
		getMode: () => mode,
		getCredentials: async () => ({ serverUrl: ELSEWHERE }),
		getNode: () => ({
			id: '1',
			name: 'Loopyah Trigger',
			type: 'loopyahTrigger',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
			credentials: { loopyahOAuth2Api: { id: account, name: 'Loopyah account' } },
		}),
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
const answer = (context, data) => (context.helpers.httpRequestWithAuthentication = async (_c, options) => {
	context.requests.push(options);
	return typeof data === 'function' ? data(options) : data;
});
// What n8n throws when Loopyah refuses a call: its own error, holding the request's error with Loopyah's answer.
const node = { id: '1', name: 'Loopyah Trigger', type: 'loopyahTrigger', typeVersion: 1, position: [0, 0], parameters: {} };
const refusal = (status, data) =>
	new NodeApiError(node, Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } }));
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

	test('keeps the sign-in and token renewal on Loopyah and lets only the Loopyah Trigger use the credential', () => {
		const credential = new LoopyahOAuth2Api();
		const fields = Object.fromEntries(credential.properties.map((p) => [p.name, p]));
		// n8n uses a hidden authUrl or accessTokenUrl as is and ignores any value saved in the credential.
		assert.deepEqual(fields.authUrl, { displayName: 'Authorization URL', name: 'authUrl', type: 'hidden', default: `${API}/authorize` });
		assert.deepEqual(fields.accessTokenUrl, { displayName: 'Access Token URL', name: 'accessTokenUrl', type: 'hidden', default: `${API}/token` });
		assert.equal(fields.serverUrl.default, API);
		// So n8n's HTTP Request node can't borrow it and send the token to another website.
		assert.equal(credential.restrictToSupportedNodes, true);
	});
});

describe('Loopyah Trigger', () => {
	test('switching on starts from the newest records without replaying history', async () => {
		const context = n8n({ pages: [[order('o2', '2026-11-09T10:00:00Z'), order('o1', '2026-11-09T09:30:00Z')]] });
		assert.equal(await poll(context), null);
		assert.equal(context.state.watching, watched());
		assert.deepEqual(Object.keys(context.state.seen).sort(), ['o1', 'o2']);
	});

	test('starts a run for each new record, oldest first, and not again on the next poll', async () => {
		const context = n8n({ pages: [[order('o2', '2026-11-09T10:00:00Z')]] });
		await poll(context);

		answer(context, (options) => ({
			data: options.qs.pageParam === 0 ? [order('o4', '2026-11-09T12:00:00Z'), order('o3', '2026-11-09T11:00:00Z'), order('o2', '2026-11-09T10:00:00Z')] : [],
		}));
		assert.deepEqual(ids(await poll(context)), ['o3', 'o4']);
		assert.equal(await poll(context), null);
	});

	test('a record sharing the newest time is new only if its ID was not seen', async () => {
		const same = '2026-11-09T10:00:00Z';
		const context = n8n({ pages: [[order('a', same)]] });
		await poll(context);

		answer(context, { data: [order('b', same), order('a', same)] });
		assert.deepEqual(ids(await poll(context)), ['b']);
		assert.equal(await poll(context), null);
	});

	test('a record that appears after a newer one, dated within the hour before it, still starts a run', async () => {
		// A contact is dated by the purchase it came from, so it can show up after a later contact.
		const context = n8n({ state: memory({ o2: at('2026-11-09T10:00:00Z') }) });
		answer(context, { data: [order('o2', '2026-11-09T10:00:00Z'), order('late', '2026-11-09T09:20:00Z'), order('old', '2026-11-09T08:00:00Z')] });
		assert.deepEqual(ids(await poll(context)), ['late']);
		assert.equal(await poll(context), null);
	});

	test('a record pushed onto the next page while reading starts one run, not two', async () => {
		const context = n8n({ state: memory({ o0: at('2026-11-09T10:00:00Z') }) });
		answer(context, (options) => ({
			data: [
				[order('n2', '2026-11-09T10:02:00Z'), order('n1', '2026-11-09T10:01:00Z')],
				[order('n1', '2026-11-09T10:01:00Z'), order('o0', '2026-11-09T10:00:00Z'), order('old', '2026-11-09T08:00:00Z')],
			][options.qs.pageParam] ?? [],
		}));
		assert.deepEqual(ids(await poll(context)), ['n1', 'n2']);
	});

	test('when the list was empty on switching on, every later record is new', async () => {
		const context = n8n({ pages: [[]] });
		assert.equal(await poll(context), null);

		answer(context, (options) => ({ data: options.qs.pageParam === 0 ? [order('o1', '2026-11-09T10:00:00Z')] : [] }));
		assert.deepEqual(ids(await poll(context)), ['o1']);
	});

	test('reads further pages until it passes the hour before the newest record it has seen', async () => {
		const newest = at('2026-11-09T12:00:00Z');
		const rows = (start, minutes) => Array.from({ length: 20 }, (_, i) => order(`p${start + i}`, new Date(newest + minutes(i) * 60000).toISOString()));
		const pages = [rows(0, (i) => 40 - i), rows(20, (i) => -1 - i), rows(40, () => -120)];
		const context = n8n({ state: memory({ seen: newest }), pages });

		const result = await poll(context);
		assert.equal(result[0].length, 40);
		assert.equal(context.requests.length, 3);
	});

	test('reads at most five pages in one poll', async () => {
		const full = (page) => Array.from({ length: 20 }, (_, i) => order(`x${page}-${i}`, '2026-11-09T12:00:00Z'));
		const context = n8n({ state: memory({ seen: at('2026-11-09T11:00:00Z') }), pages: Array.from({ length: 9 }, (_, page) => full(page)) });
		const result = await poll(context);
		assert.equal(context.requests.length, 5);
		assert.equal(result[0].length, 100);
	});

	test('testing in the editor returns the latest record and leaves what the trigger remembers alone', async () => {
		const state = memory({ old: 1 });
		const before = structuredClone(state);
		const context = n8n({ mode: 'manual', state, pages: [[order('o9', '2026-11-09T12:00:00Z'), order('o8', '2026-11-09T11:00:00Z')]] });
		assert.deepEqual(ids(await poll(context)), ['o9']);
		assert.deepEqual(state, before);
	});

	test('changing the trigger or organizer starts fresh', async () => {
		const context = n8n({ event: 'order', organizer: 'org_2', state: memory({ x: 5 }), pages: [[]] });
		assert.equal(await poll(context), null);
		assert.deepEqual(context.state, { watching: watched('order', 'org_2') });
	});

	test('switching to another Loopyah account starts fresh instead of replaying its records', async () => {
		const context = n8n({ account: 'acc2', state: memory({ o1: at('2026-11-09T10:00:00Z') }), pages: [[order('theirs', '2026-11-09T09:00:00Z')]] });
		assert.equal(await poll(context), null);
		assert.equal(context.state.watching, watched('order', '', 'acc2'));
	});

	test('a trigger switched on with version 0.1.2 carries on from what it remembered', async () => {
		const context = n8n({ state: { watching: 'order:', lastTime: at('2026-11-09T10:00:00Z'), idsAtLastTime: ['o2'] } });
		answer(context, { data: [order('o3', '2026-11-09T11:00:00Z'), order('o2', '2026-11-09T10:00:00Z')] });
		assert.deepEqual(ids(await poll(context)), ['o3']);
		assert.equal(context.state.watching, watched());
		assert.equal(context.state.lastTime, undefined);
	});

	test('sends every request to Loopyah, whatever server URL the credential holds', async () => {
		const context = n8n({ pages: [[]] });
		await poll(context);
		assert.ok(context.requests.length > 0);
		for (const { url } of context.requests) assert.ok(url.startsWith(`${API}/`), url);
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
		answer(context, { data: { contacts: [{ id: 'c1', createdAt: '2026-11-09T10:00:00Z' }] } });
		assert.deepEqual(ids(await poll(context)), ['c1']);
		assert.deepEqual(context.requests[0].qs, { page: 1 });
	});

	test('check-ins use the scan time, or the hand check-in time when there was no scan', async () => {
		const checkIn = (id, scannedAt, checkedInAt) => ({ ticket: { id, scannedAt, checkedInAt } });
		const context = n8n({ event: 'checkIn', state: memory({ t0: at('2026-11-09T10:00:00Z') }, 'checkIn') });
		answer(context, { data: [checkIn('t2', null, '2026-11-09T12:00:00Z'), checkIn('t1', '2026-11-09T11:00:00Z', null), checkIn('t0', '2026-11-09T10:00:00Z', null)] });
		assert.deepEqual(ids(await poll(context)), ['t1', 't2']);
	});

	test('payouts take their ID and paid time from whichever payout they are', async () => {
		const context = n8n({ event: 'payout', state: memory({ old: at('2026-11-09T10:00:00Z') }, 'payout') });
		answer(context, {
			data: [
				{ source: 'pos', posPayout: { id: 'pp1', transferredAt: '2026-11-09T12:00:00Z' } },
				{ source: 'ticket', ticketPayout: { id: 'tp1', statusChangedAt: '2026-11-09T11:00:00Z' } },
				{ source: 'sponsorship', sponsorshipPayout: { id: 'sp0', transferredAt: '2026-11-09T08:00:00Z' } },
			],
		});
		const result = await poll(context);
		assert.deepEqual(result[0].map((i) => i.json.source), ['ticket', 'pos']);
		assert.equal(context.state.seen.pp1, at('2026-11-09T12:00:00Z'));
	});

	test('a refusal shows Loopyah\'s own message and status, whether Loopyah sent text or JSON', async () => {
		const plain = n8n({});
		answer(plain, () => {
			throw refusal(400, 'The input provided is incorrect or missing.');
		});
		await assert.rejects(poll(plain), (error) => error.constructor.name === 'NodeApiError' && error.message === '[400] The input provided is incorrect or missing.');

		const json = n8n({});
		answer(json, () => {
			throw refusal(403, { error: 'You need a team role that can read orders' });
		});
		await assert.rejects(poll(json), (error) => error.message === '[403] You need a team role that can read orders');
	});

	test('an answer without a list fails instead of passing as an empty list', async () => {
		const context = n8n({});
		answer(context, { data: { unexpected: true } });
		await assert.rejects(poll(context), (error) => error.constructor.name === 'NodeOperationError');
		assert.deepEqual(context.state, {});
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
