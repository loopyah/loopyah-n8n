import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { LISTS } from './lists';
import { CREDENTIAL, getOrganizers, post } from './request';
import { isSignedByLoopyah } from './signature';

interface Subscription {
	secret?: string;
	url?: string;
	webhookId?: string;
}

type RawRequest = { rawBody?: Buffer };

const header = (headers: IDataObject, name: string) => String(headers[name] ?? '');

// Loopyah sends each new record to n8n as it happens. Activating the workflow subscribes this node's address to the
// trigger's Loopyah webhook, and deactivating it unsubscribes, so nothing is asked for and nothing is missed. n8n that
// Loopyah can't reach, such as one on localhost, uses the Loopyah Trigger instead.
export class LoopyahInstantTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Loopyah Instant Trigger',
		name: 'loopyahInstantTrigger',
		icon: { light: 'file:loopyah.svg', dark: 'file:loopyah.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description: 'Starts the workflow the moment something happens in Loopyah',
		defaults: {
			name: 'Loopyah Instant Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: CREDENTIAL,
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Trigger On',
				name: 'event',
				type: 'options',
				required: true,
				default: 'order',
				options: LISTS.map(({ value, name, description }) => ({ value, name, description })),
			},
			{
				displayName: 'Organizer Name or ID',
				name: 'organizer',
				type: 'options',
				default: '',
				typeOptions: {
					loadOptionsMethod: 'getOrganizers',
				},
				description:
					'Leave empty to use your own account, or pick an organizer whose team you\'re on. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
		],
	};

	methods = {
		loadOptions: { getOrganizers },
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const state = this.getWorkflowStaticData('node') as Subscription;
				return !!state.webhookId && state.url === this.getNodeWebhookUrl('default');
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const event = this.getNodeParameter('event') as string;
				const organizer = this.getNodeParameter('organizer', '') as string;
				const list = LISTS.find((i) => i.value === event);
				if (!list) throw new NodeOperationError(this.getNode(), `Unknown trigger: ${event}`);

				const url = this.getNodeWebhookUrl('default') as string;
				const body: IDataObject = { type: list.type, url };
				if (organizer) body.creator = organizer;

				const { data } = (await post.call(this, '/webhook/subscribe', body)) as {
					data: IDataObject;
				};
				const state = this.getWorkflowStaticData('node') as Subscription;
				state.webhookId = String(data.id);
				state.secret = String(data.secret);
				state.url = url;
				return true;
			},

			// The saved subscription is forgotten even when Loopyah can't end it, such as one left on a disconnected
			// account, so activating the workflow again always subscribes afresh.
			async delete(this: IHookFunctions): Promise<boolean> {
				const state = this.getWorkflowStaticData('node') as Subscription;
				const { webhookId } = state;

				delete state.webhookId;
				delete state.secret;
				delete state.url;

				if (webhookId) await post.call(this, '/webhook/unsubscribe', { id: webhookId });
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const { secret } = this.getWorkflowStaticData('node') as Subscription;
		const headers = this.getHeaderData() as IDataObject;
		const payload = this.getBodyData() as IDataObject;
		const raw = (this.getRequestObject() as RawRequest).rawBody;

		const signed = {
			body: raw ? raw.toString('utf8') : JSON.stringify(payload),
			id: header(headers, 'webhook-id'),
			signature: header(headers, 'webhook-signature'),
			timestamp: header(headers, 'webhook-timestamp'),
		};

		// A send that Loopyah didn't sign is refused, so Loopyah retries it and nothing else can start the workflow.
		if (!secret || !isSignedByLoopyah(secret, signed)) {
			this.getResponseObject().status(401).send('Unauthorized');
			return { noWebhookResponse: true };
		}

		return { workflowData: [this.helpers.returnJsonArray([payload.data as IDataObject])] };
	}
}
