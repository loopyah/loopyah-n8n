# loopyah-n8n

The [Loopyah](https://loopyah.com) node for [n8n](https://n8n.io), published to npm as `n8n-nodes-loopyah`. Loopyah is an event ticketing platform. This package starts n8n workflows when something happens in your Loopyah account.

## Installation

On self-hosted n8n, go to **Settings > Community Nodes > Install** and enter `n8n-nodes-loopyah`. n8n's [community nodes guide](https://docs.n8n.io/integrations/community-nodes/installation/) has the details.

## Credentials

Create a **Loopyah OAuth2 API** credential and click **Connect**. Sign in to Loopyah and choose whether n8n can only read your data or read and change it. There's no client ID or secret to copy: n8n registers itself with Loopyah when you connect.

The connection shows on your Loopyah connectors page, and disconnecting it there ends n8n's access.

## Loopyah Trigger

Starts a workflow for each new record, across every event you run.

| Trigger on | Starts when |
| --- | --- |
| New Check-In | A guest is let in, by a ticket scan or a check-in by hand |
| New Contact | Someone is added to your contacts |
| New Order | A customer pays for tickets |
| New Point-of-Sale Sale | You take an in-person sale with Tap to Pay |
| New Refund | A refund is paid back to a customer |
| New Review | A guest reviews one of your events |
| New Sponsor Application | A sponsor applies to one of your events |
| Payout Paid | Loopyah sends a payout to your bank |

- **Organizer:** leave it empty to use your own account, or pick an organizer whose team you're on. Your team role decides what you can read.
- **First run:** a workflow switched on for the first time starts from your newest record and doesn't replay your history.
- **Each check** reads up to 100 new records. **Fetch Test Event** shows your latest record.

## Compatibility

Tested with n8n 2.46.

## Development

n8n needs Node 24 (`.nvmrc`).

```bash
npm install
```

```bash
npm run dev
```

That builds the package, starts n8n at http://localhost:5678 with the package loaded and rebuilds on every change.

```bash
npm test
```

```bash
npm run lint
```

The API address is `API_URL` in `credentials/LoopyahOAuth2Api.credentials.ts`. Publishing is refused unless it's the live API.

### Publishing

`.github/workflows/publish.yml` publishes to npm with a provenance statement on every version tag, and `npm run release` makes the tag. Nothing is published from a laptop.

### Layout

- `credentials/LoopyahOAuth2Api.credentials.ts`: sign-in
- `nodes/Loopyah/LoopyahTrigger.node.ts`: the trigger, its Organizer list and polling
- `nodes/Loopyah/lists.ts`: the eight Loopyah lists, and where each keeps its rows, IDs and times
- `nodes/Loopyah/newRecords.ts`: which records are new since the last check
- `test/`: tests against the built package, with Loopyah's API faked

## License

[MIT](LICENSE.md)
