import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const { LoopyahInstantTrigger } = require('../dist/nodes/Loopyah/LoopyahInstantTrigger.node.js');
const { API_URL: API } = require('../dist/nodes/Loopyah/api.js');
const { NodeApiError } = require('n8n-workflow');

const trigger = new LoopyahInstantTrigger();
const hooks = trigger.webhookMethods.default;
const HOOK_URL = 'https://n8n.example.com/webhook/abc/webhook';
const SECRET = `whsec_${randomBytes(32).toString('base64')}`;

const node = {
	id: '1',
	name: 'Loopyah Instant Trigger',
	type: 'loopyahInstantTrigger',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

// A stand-in for n8n while it activates or deactivates a workflow, recording each request to Loopyah.
const activating = ({
	event = 'order',
	organizer = '',
	state = {},
	url = HOOK_URL,
	answer,
} = {}) => {
	const requests = [];
	return {
		requests,
		state,
		getNode: () => node,
		getNodeParameter: (name, fallback) => ({ event, organizer })[name] ?? fallback,
		getNodeWebhookUrl: () => url,
		getWorkflowStaticData: () => state,
		getCredentials: async () => ({ serverUrl: 'https://elsewhere.example' }),
		helpers: {
			httpRequestWithAuthentication: async (credential, options) => {
				requests.push({ credential, ...options });
				if (answer) return answer(options);
				return { data: { id: 'sub_1', secret: SECRET, type: options.body.type } };
			},
		},
	};
};

const sign = (
	body,
	{ id = 'wd_1', secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {},
) => {
	const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
	const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
	return {
		'webhook-id': id,
		'webhook-signature': `v1,${signature}`,
		'webhook-timestamp': String(timestamp),
	};
};

// A stand-in for n8n receiving a send from Loopyah.
const receiving = ({ body, headers, state = { secret: SECRET, webhookId: 'sub_1' } }) => {
	const response = { status: null, sent: null };
	return {
		response,
		getWorkflowStaticData: () => state,
		getHeaderData: () => headers,
		getBodyData: () => JSON.parse(body),
		getRequestObject: () => ({ rawBody: Buffer.from(body) }),
		getResponseObject: () => ({
			status(code) {
				response.status = code;
				return this;
			},
			send(text) {
				response.sent = text;
			},
		}),
		helpers: { returnJsonArray: (rows) => rows.map((json) => ({ json })) },
	};
};

const send = (data) =>
	JSON.stringify({
		creator: 'usr_1',
		data,
		id: 'wd_1',
		timestamp: '2026-11-10T00:00:00.000Z',
		type: 'order.paid',
	});

describe('activating', () => {
	test("subscribes the workflow address to the trigger's Loopyah webhook and remembers the subscription", async () => {
		const context = activating({ event: 'checkIn' });

		assert.equal(await hooks.checkExists.call(context), false);
		assert.equal(await hooks.create.call(context), true);

		const [request] = context.requests;
		assert.equal(request.method, 'POST');
		assert.equal(request.url, `${API}/webhook/subscribe`);
		assert.equal(request.credential, 'loopyahOAuth2Api');
		assert.deepEqual(request.body, { type: 'ticket.checked_in', url: HOOK_URL });
		assert.deepEqual(context.state, { secret: SECRET, url: HOOK_URL, webhookId: 'sub_1' });
		assert.equal(await hooks.checkExists.call(context), true);
	});

	test('subscribes for the picked organizer', async () => {
		const context = activating({ organizer: 'usr_organizer' });
		await hooks.create.call(context);

		assert.deepEqual(context.requests[0].body, {
			creator: 'usr_organizer',
			type: 'order.paid',
			url: HOOK_URL,
		});
	});

	test('every trigger subscribes to its own webhook', async () => {
		const types = {};
		for (const option of trigger.description.properties[0].options) {
			const context = activating({ event: option.value });
			await hooks.create.call(context);
			types[option.value] = context.requests[0].body.type;
		}

		assert.deepEqual(types, {
			checkIn: 'ticket.checked_in',
			contact: 'contact.created',
			customerRefund: 'customer_refund.paid',
			order: 'order.paid',
			payout: 'payout.paid',
			refund: 'refund.paid',
			review: 'review.created',
			sale: 'pos_sale.paid',
			sponsor: 'sponsor_application.created',
		});
	});

	test('subscribes again when the workflow address changes', async () => {
		const context = activating({
			state: { secret: SECRET, url: 'https://old.example/webhook', webhookId: 'sub_0' },
		});
		assert.equal(await hooks.checkExists.call(context), false);
	});

	test("shows Loopyah's message when it refuses, such as for an n8n it can't reach", async () => {
		const message = 'Loopyah can only send to a secure https address on the public internet.';
		const context = activating({
			url: 'http://localhost:5678/webhook/abc/webhook',
			answer: () => {
				throw new NodeApiError(
					node,
					Object.assign(new Error('Request failed with status code 400'), {
						response: { status: 400, data: message },
					}),
				);
			},
		});

		await assert.rejects(hooks.create.call(context), { message: `[400] ${message}` });
		assert.deepEqual(context.state, {});
	});

	test('unsubscribes when the workflow is deactivated', async () => {
		const context = activating({ state: { secret: SECRET, url: HOOK_URL, webhookId: 'sub_1' } });

		assert.equal(await hooks.delete.call(context), true);
		assert.deepEqual(context.requests[0].body, { id: 'sub_1' });
		assert.equal(context.requests[0].url, `${API}/webhook/unsubscribe`);
		assert.deepEqual(context.state, {});
	});

	test("forgets the subscription even when Loopyah can't end it, so activating again subscribes afresh", async () => {
		const context = activating({
			state: { secret: SECRET, url: HOOK_URL, webhookId: 'sub_lost' },
			answer: () => {
				throw new Error("We couldn't find this subscription.");
			},
		});

		await assert.rejects(hooks.delete.call(context));
		assert.deepEqual(context.state, {});
		assert.equal(await hooks.checkExists.call(context), false);
	});
});

describe('receiving', () => {
	test('starts the workflow with the record Loopyah sent, the same fields the Loopyah Trigger gives', async () => {
		const body = send({ id: 'ti_1', amountCents: 2500 });
		const result = await trigger.webhook.call(receiving({ body, headers: sign(body) }));

		assert.deepEqual(result, { workflowData: [[{ json: { id: 'ti_1', amountCents: 2500 } }]] });
	});

	test("refuses a send Loopyah didn't sign, so it can't start the workflow", async () => {
		const body = send({ id: 'ti_1' });
		const forged = [
			{ headers: sign(body, { secret: `whsec_${randomBytes(32).toString('base64')}` }) },
			{ headers: sign(send({ id: 'ti_2' })) },
			{ headers: sign(body, { timestamp: Math.floor(Date.now() / 1000) - 3600 }) },
			{ headers: {} },
			{ headers: sign(body), state: {} },
		];

		for (const { headers, state } of forged) {
			const context = receiving({ body, headers, state });
			const result = await trigger.webhook.call(context);

			assert.deepEqual(result, { noWebhookResponse: true });
			assert.equal(context.response.status, 401);
		}
	});
});
