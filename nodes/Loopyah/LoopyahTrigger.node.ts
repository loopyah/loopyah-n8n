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
import { at, LISTS, type LoopyahList } from './lists';
import { MAX_PAGES, remember, type SeenState, takeNew } from './newRecords';

const CREDENTIAL = 'loopyahOAuth2Api';

const request = async function (
	this: IPollFunctions | ILoadOptionsFunctions,
	path: string,
	qs: IDataObject = {},
): Promise<IDataObject> {
	const { serverUrl } = await this.getCredentials(CREDENTIAL);
	try {
		return (await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL, {
			method: 'GET',
			url: `${serverUrl as string}${path}`,
			qs,
			json: true,
		})) as IDataObject;
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject);
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

	const rows = at(await request.call(this, list.path, qs), list.rows);
	return Array.isArray(rows) ? (rows as IDataObject[]) : [];
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
		const watching = `${event}:${organizer}`;

		// The first poll, or a change of trigger or organizer, starts from the newest record without replaying history.
		if (state.watching !== watching) {
			const newest = await readPage.call(this, list, organizer, 0);
			delete state.lastTime;
			delete state.idsAtLastTime;
			Object.assign(state, remember(list, watching, newest, {}));
			return null;
		}

		const found: IDataObject[] = [];
		for (let page = 0; page < MAX_PAGES; page++) {
			const rows = await readPage.call(this, list, organizer, page);
			const { fresh, reachedSeen } = takeNew(list, rows, state);
			found.push(...fresh);
			if (reachedSeen || !rows.length) break;
		}

		if (!found.length) return null;

		Object.assign(state, remember(list, watching, found, state));
		return [this.helpers.returnJsonArray(found.reverse())];
	}
}
