import type { IDataObject } from 'n8n-workflow';
import { type LoopyahList, recordId, recordTime } from './lists';

// What a trigger remembers between polls: which list it watches, and the newest record it has seen.
export interface SeenState {
	watching?: string;
	lastTime?: number;
	idsAtLastTime?: string[];
}

export const MAX_PAGES = 5;

// Rows come newest first. Records sharing the last seen time are new only if their ID wasn't seen.
export const takeNew = (list: LoopyahList, rows: IDataObject[], state: SeenState) => {
	const lastTime = state.lastTime ?? -Infinity;
	const seen = new Set(state.idsAtLastTime ?? []);
	const fresh: IDataObject[] = [];
	let reachedSeen = false;

	for (const row of rows) {
		const time = recordTime(list, row);
		if (time < lastTime) return { fresh, reachedSeen: true };
		if (time > lastTime || !seen.has(recordId(list, row))) fresh.push(row);
		else reachedSeen = true;
	}

	return { fresh, reachedSeen };
};

export const remember = (
	list: LoopyahList,
	watching: string,
	newestFirst: IDataObject[],
	state: SeenState,
): SeenState => {
	if (!newestFirst.length) return { ...state, watching };

	const lastTime = recordTime(list, newestFirst[0]);
	const ids = newestFirst.filter((row) => recordTime(list, row) === lastTime).map((row) => recordId(list, row));
	const kept = state.lastTime === lastTime ? (state.idsAtLastTime ?? []) : [];

	return { watching, lastTime, idsAtLastTime: [...new Set([...kept, ...ids])] };
};
