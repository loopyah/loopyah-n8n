import type {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { at, LISTS, type LoopyahList, recordTime } from './lists';
import { MAX_PAGES, remember, type SeenState, takeNew, upgrade } from './newRecords';
import { CREDENTIAL, getOrganizers, request } from './request';

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
		loadOptions: { getOrganizers },
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
