import type { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';

// Set it to https://api-dev.loopyah.com to test against dev locally. scripts/check-live.mjs stops a publish that points anywhere else.
const API_URL = 'https://api.loopyah.com';

// n8n registers itself with Loopyah on Connect, the way Claude and ChatGPT do, so there's no client ID or secret to enter.
export class LoopyahOAuth2Api implements ICredentialType {
	name = 'loopyahOAuth2Api';

	extends = ['oAuth2Api'];

	displayName = 'Loopyah OAuth2 API';

	icon: Icon = {
		light: 'file:../nodes/Loopyah/loopyah.svg',
		dark: 'file:../nodes/Loopyah/loopyah.dark.svg',
	};

	documentationUrl = 'https://loopyah.com/resources/connect-n8n';

	properties: INodeProperties[] = [
		{
			displayName: 'Use Dynamic Client Registration',
			name: 'useDynamicClientRegistration',
			type: 'hidden',
			default: true,
		},
		{
			displayName: 'Server URL',
			name: 'serverUrl',
			type: 'hidden',
			default: API_URL,
		},
	];
}
