import type {
	IDataObject,
	IHookFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	IPollFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { API_URL } from './api';
import { at } from './lists';

export const CREDENTIAL = 'loopyahOAuth2Api';

type Context = IPollFunctions | ILoadOptionsFunctions | IHookFunctions;
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

const send = async function (
	this: Context,
	method: IHttpRequestMethods,
	path: string,
	options: { body?: IDataObject; qs?: IDataObject },
): Promise<IDataObject> {
	// The address is fixed here, never read from the credential, so nothing saved there can send the token elsewhere.
	try {
		return (await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL, {
			method,
			url: `${API_URL}${path}`,
			...options,
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

export const request = function (this: Context, path: string, qs: IDataObject = {}) {
	return send.call(this, 'GET', path, { qs });
};

export const post = function (this: Context, path: string, body: IDataObject) {
	return send.call(this, 'POST', path, { body });
};

export async function getOrganizers(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const teams = at(await request.call(this, '/data/my-teams'), 'data');
	const organizers = (Array.isArray(teams) ? (teams as IDataObject[]) : []).map((team) => ({
		name: String(at(team, 'creator.name') ?? ''),
		value: String(at(team, 'creator.id') ?? ''),
	}));
	return [{ name: 'My Account', value: '' }, ...organizers];
}
