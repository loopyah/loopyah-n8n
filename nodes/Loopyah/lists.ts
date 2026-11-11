import type { IDataObject } from 'n8n-workflow';

export interface LoopyahList {
	value: string;
	name: string;
	description: string;
	path: string;
	// Most lists page from 0. Contacts page from 1 and nest their rows.
	pagesFromOne?: boolean;
	rows: string;
	// The first field that has a value wins, for records that come from more than one source.
	id: string[];
	// When the record happened. Every list is sorted newest first by this.
	happenedAt: string[];
	// The Loopyah webhook the instant trigger subscribes to.
	type: string;
}

export const at = (record: IDataObject, path: string): unknown =>
	path
		.split('.')
		.reduce<unknown>(
			(value, key) =>
				value && typeof value === 'object' ? (value as IDataObject)[key] : undefined,
			record,
		);

const first = (record: IDataObject, paths: string[]) =>
	paths.map((path) => at(record, path)).find((value) => value !== undefined && value !== null && value !== '');

export const recordId = (list: LoopyahList, record: IDataObject) => String(first(record, list.id) ?? '');

export const recordTime = (list: LoopyahList, record: IDataObject) => {
	const value = first(record, list.happenedAt);
	const time = typeof value === 'string' || typeof value === 'number' ? Date.parse(String(value)) : NaN;
	return Number.isNaN(time) ? 0 : time;
};

export const LISTS: LoopyahList[] = [
	{
		value: 'checkIn',
		type: 'ticket.checked_in',
		name: 'New Check-In',
		description: 'A guest is let in at any of your events, by a ticket scan or a check-in by hand',
		path: '/data/creator-check-ins',
		rows: 'data',
		id: ['ticket.id'],
		happenedAt: ['ticket.scannedAt', 'ticket.checkedInAt'],
	},
	{
		value: 'contact',
		type: 'contact.created',
		name: 'New Contact',
		description: 'Someone is added to your contacts',
		path: '/data/creator-contacts',
		pagesFromOne: true,
		rows: 'data.contacts',
		id: ['id'],
		happenedAt: ['createdAt'],
	},
	{
		value: 'customerRefund',
		type: 'customer_refund.paid',
		name: 'New Customer Refund',
		description: "A customer's own refund request for any of your events is complete",
		path: '/data/creator-ticket-refunds',
		rows: 'data',
		id: ['id'],
		happenedAt: ['refundedAt'],
	},
	{
		value: 'order',
		type: 'order.paid',
		name: 'New Order',
		description: 'A customer pays for tickets to any of your events',
		path: '/data/creator-ticket-orders',
		rows: 'data',
		id: ['id'],
		happenedAt: ['paymentSucceededAt'],
	},
	{
		value: 'refund',
		type: 'refund.paid',
		name: 'New Organizer Refund',
		description: 'A refund you issued for any of your events is complete',
		path: '/data/creator-ticket-refund-intents',
		rows: 'data',
		id: ['id'],
		happenedAt: ['paymentSucceededAt'],
	},
	{
		value: 'sale',
		type: 'pos_sale.paid',
		name: 'New Point-of-Sale Sale',
		description: 'You take an in-person sale with Tap to Pay at any of your events',
		path: '/data/creator-pos-transactions',
		rows: 'data',
		id: ['id'],
		happenedAt: ['paymentSucceededAt'],
	},
	{
		value: 'review',
		type: 'review.created',
		name: 'New Review',
		description: 'A guest reviews any of your events',
		path: '/data/creator-event-reviews',
		rows: 'data',
		id: ['review.id'],
		happenedAt: ['review.createdAt'],
	},
	{
		value: 'sponsor',
		type: 'sponsor_application.created',
		name: 'New Sponsor Application',
		description: 'A sponsor applies to any of your events',
		path: '/data/creator-sponsorship-sponsors',
		rows: 'data',
		id: ['sponsor.id'],
		happenedAt: ['sponsor.createdAt'],
	},
	{
		value: 'payout',
		type: 'payout.paid',
		name: 'Payout Paid',
		description: 'A payout for your tickets, point-of-sale sales or a sponsorship has been paid',
		path: '/data/creator-paid-payouts',
		rows: 'data',
		id: ['ticketPayout.id', 'posPayout.id', 'sponsorshipPayout.id'],
		happenedAt: [
			'ticketPayout.statusChangedAt',
			'posPayout.transferredAt',
			'sponsorshipPayout.transferredAt',
		],
	},
];
