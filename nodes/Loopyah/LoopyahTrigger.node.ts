import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { API_URL } from './api';
import { at, LISTS, type LoopyahList, recordTime } from './lists';
import { MAX_PAGES, remember, type SeenState, takeNew, upgrade } from './newRecords';

const CREDENTIAL = 'loopyahOAuth2Api';

type Failed = { response?: { status?: number; data?: unknown }; cause?: unknown };

// Loopyah explains a refusal as JSON { error } or as plain text. n8n would replace it with its own generic wording,
// such as "Bad request", so Loopyah's text is passed on as the message, after the status code.
const loopyahMessage = (error: Failed | undefined) => {
	const response = error?.response;
	const data = response?.data;
	const text =
		typeof data === 'string'
			? data
			: ((data as { error?: unknown; message?: unknown } | undefined)?.error ??
				(data as { message?: unknown } | undefined)?.message);
	if (typeof text !== 'string' || !text.trim() || text.trim().startsWith('<')) return undefined;
	return response?.status ? `[${response.status}] ${text.trim()}` : text.trim();
};

const request = async function (
	this: IPollFunctions | ILoadOptionsFunctions,
	path: string,
	qs: IDataObject = {},
): Promise<IDataObject> {
	// The address is fixed here, never read from the credential, so nothing saved there can send the token elsewhere.
	try {
		return (await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL, {
			method: 'GET',
			url: `${API_URL}${path}`,
			qs,
			json: true,
		})) as IDataObject;
	} catch (error) {
		// n8n hands back its own error with the request's error, and Loopyah's answer, inside it. Re-wrapping n8n's error
		// would keep its wording, so the error inside it is wrapped again with Loopyah's message.
		const inner = ((error as Failed).cause as Failed | undefined) ?? (error as Failed);
		const message = loopyahMessage(inner) ?? loopyahMessage(error as Failed);
		if (!message) throw new NodeApiError(this.getNode(), error as JsonObject);
		throw new NodeApiError(this.getNode(), inner as JsonObject, { message });
	}
};

const readPage = async function (
	this: IPollFunctions,
	list: LoopyahList,
	organizer: string,
	page: number,
): Promise<IDataObject[]> {
	const qs: IDataObject = list.pagesFromOne ? { page: page + 1 } : { pageParam: page };
	if (organizer) qs.creator = organizer;

	// An answer without a list is an error, not an empty list, so a first poll never starts from nothing.
	const rows = at(await request.call(this, list.path, qs), list.rows);
	if (!Array.isArray(rows))
		throw new NodeOperationError(
			this.getNode(),
			`Loopyah sent an unexpected answer for ${list.name}`,
		);
	return rows as IDataObject[];
};

export class LoopyahTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Loopyah Trigger',
		name: 'loopyahTrigger',
		icon: { light: 'file:loopyah.svg', dark: 'file:loopyah.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description: 'Starts the workflow when something happens in Loopyah',
		defaults: {
			name: 'Loopyah Trigger',
		},
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: CREDENTIAL,
				required: true,
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
		loadOptions: {
			async getOrganizers(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const teams = at(await request.call(this, '/data/my-teams'), 'data');
				const organizers = (Array.isArray(teams) ? (teams as IDataObject[]) : []).map((team) => ({
					name: String(at(team, 'creator.name') ?? ''),
					value: String(at(team, 'creator.id') ?? ''),
				}));
				return [{ name: 'My Account', value: '' }, ...organizers];
			},
		},
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const event = this.getNodeParameter('event') as string;
		const organizer = this.getNodeParameter('organizer', '') as string;
		const list = LISTS.find((i) => i.value === event);
		if (!list) throw new NodeOperationError(this.getNode(), `Unknown trigger: ${event}`);

		// Testing in the editor shows the latest record and leaves what the trigger remembers alone.
		if (this.getMode() === 'manual') {
			const [latest] = await readPage.call(this, list, organizer, 0);
			return latest ? [this.helpers.returnJsonArray([latest])] : null;
		}

		const state = this.getWorkflowStaticData('node') as SeenState;
		// The Loopyah account is part of what's watched, so switching accounts starts fresh like switching triggers.
		const account = this.getNode().credentials?.[CREDENTIAL]?.id ?? '';
		const watching = `${account}:${event}:${organizer}`;
		const replace = (next: SeenState) => {
			for (const key of Object.keys(state)) delete state[key as keyof SeenState];
			Object.assign(state, next);
		};

		const upgraded = upgrade(state, `${event}:${organizer}`, watching);
		if (upgraded) replace(upgraded);

		// The first poll, or a change of account, trigger or organizer, starts from the newest records without replaying
		// history.
		if (state.watching !== watching) {
			replace(remember(list, watching, await readPage.call(this, list, organizer, 0), {}));
			return null;
		}

		const taken = new Set<string>();
		const found: IDataObject[] = [];
		for (let page = 0; page < MAX_PAGES; page++) {
			const rows = await readPage.call(this, list, organizer, page);
			const { fresh, done } = takeNew(list, rows, state, taken);
			found.push(...fresh);
			if (done || !rows.length) break;
		}

		if (!found.length) return null;

		replace(remember(list, watching, found, state));
		// Oldest first, so workflows run in the order things happened.
		const oldestFirst = found.reverse().sort((a, b) => recordTime(list, a) - recordTime(list, b));
		return [this.helpers.returnJsonArray(oldestFirst)];
	}
}
