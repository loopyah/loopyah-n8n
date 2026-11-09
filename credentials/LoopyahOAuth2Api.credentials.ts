import type { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';
import { API_URL } from '../nodes/Loopyah/api';

// n8n registers itself with Loopyah on Connect, the way Claude and ChatGPT do, so there's no client ID or secret to enter.
export class LoopyahOAuth2Api implements ICredentialType {
	name = 'loopyahOAuth2Api';

	extends = ['oAuth2Api'];

	// Only the Loopyah Trigger can use this credential, so n8n's HTTP Request node can't send its token to another website.
	restrictToSupportedNodes = true as const;

	displayName = 'Loopyah OAuth2 API';

	icon: Icon = {
		light: 'file:../nodes/Loopyah/loopyah.svg',
		dark: 'file:../nodes/Loopyah/loopyah.dark.svg',
	};

	documentationUrl = 'https://loopyah.com/resources/connect-n8n';

	// n8n keeps hidden sign-in addresses at these values whatever is saved in the credential, so the sign-in and every
	// token renewal stay on Loopyah. The server URL is only where n8n reads Loopyah's sign-in details on Connect; changing
	// it can't move the token, because the addresses below are fixed and the trigger uses API_URL.
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
		{
			displayName: 'Authorization URL',
			name: 'authUrl',
			type: 'hidden',
			default: `${API_URL}/authorize`,
		},
		{
			displayName: 'Access Token URL',
			name: 'accessTokenUrl',
			type: 'hidden',
			default: `${API_URL}/token`,
		},
	];
}
