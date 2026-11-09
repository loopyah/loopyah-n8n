import type { IDataObject } from 'n8n-workflow';
import { type LoopyahList, recordId, recordTime } from './lists';

// What a trigger remembers between polls: which list it watches, the newest time it has seen, and the records it has
// seen recently, by ID, with their times.
export interface SeenState {
	watching?: string;
	newest?: number;
	seen?: Record<string, number>;
	// What 0.1.2 remembered. A trigger switched on before this version carries on from it.
	lastTime?: number;
	idsAtLastTime?: string[];
}

export const MAX_PAGES = 5;

// A record can appear in Loopyah after a newer one: a contact is dated by the purchase it came from, and an order by
// when it was paid, before the order finishes. So each poll looks back this far behind the newest record it has seen,
// and any record in that window it hasn't seen is new.
export const LOOK_BACK_MS = 60 * 60 * 1000;

// Enough to cover every record one poll can read, with room for the look-back window.
const MAX_SEEN = 500;

// Rows come newest first. A row is new unless it was seen before or already taken in this poll, which happens when a
// record arriving mid-poll pushes a row onto the next page. Reading stops at the first row older than the window.
export const takeNew = (
	list: LoopyahList,
	rows: IDataObject[],
	state: SeenState,
	taken: Set<string>,
) => {
	const from = (state.newest ?? -Infinity) - LOOK_BACK_MS;
	const seen = state.seen ?? {};
	const fresh: IDataObject[] = [];

	for (const row of rows) {
		if (recordTime(list, row) < from) return { fresh, done: true };
		const id = recordId(list, row);
		if (id in seen || taken.has(id)) continue;
		taken.add(id);
		fresh.push(row);
	}

	return { fresh, done: false };
};

export const remember = (
	list: LoopyahList,
	watching: string,
	rows: IDataObject[],
	state: SeenState,
): SeenState => {
	const seen: Record<string, number> = { ...(state.seen ?? {}) };
	for (const row of rows) seen[recordId(list, row)] = recordTime(list, row);

	const times = Object.values(seen);
	if (!times.length) return { watching };

	const newest = Math.max(state.newest ?? -Infinity, ...times);
	const kept = Object.entries(seen)
		.filter(([, time]) => time >= newest - LOOK_BACK_MS)
		.sort(([, a], [, b]) => b - a)
		.slice(0, MAX_SEEN);

	return { watching, newest, seen: Object.fromEntries(kept) };
};

// Turns what 0.1.2 remembered into the current form, so an upgrade neither replays nor skips records.
export const upgrade = (
	state: SeenState,
	oldWatching: string,
	watching: string,
): SeenState | undefined => {
	if (state.watching !== oldWatching || state.lastTime === undefined) return undefined;
	const lastTime = state.lastTime;
	return {
		watching,
		newest: lastTime,
		seen: Object.fromEntries((state.idsAtLastTime ?? []).map((id) => [id, lastTime])),
	};
};
