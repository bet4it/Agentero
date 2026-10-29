export type ShortcutBinding = {
	key: string;
	meta?: boolean;
	ctrl?: boolean;
	alt?: boolean;
	shift?: boolean;
};

/** Null disables a shortcut; absent command ids keep their defaults. */
export type ShortcutOverrides = Record<string, ShortcutBinding | null>;

function isRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Validate storage shape without depending on the shell shortcut registry. */
export function normalizeShortcutOverrides(raw: unknown): ShortcutOverrides {
	if (!isRecord(raw)) return {};
	const entries: [string, ShortcutBinding | null][] = [];
	for (const [id, value] of Object.entries(raw)) {
		if (!id.trim()) continue;
		if (value === null) {
			entries.push([id, null]);
			continue;
		}
		if (
			!isRecord(value) ||
			!Object.hasOwn(value, "key") ||
			typeof value.key !== "string" ||
			value.key.length === 0
		) {
			continue;
		}
		const binding: ShortcutBinding = { key: value.key };
		let valid = true;
		for (const modifier of ["meta", "ctrl", "alt", "shift"] as const) {
			if (!Object.hasOwn(value, modifier) || value[modifier] === undefined)
				continue;
			if (typeof value[modifier] !== "boolean") {
				valid = false;
				break;
			}
			binding[modifier] = value[modifier];
		}
		if (valid) entries.push([id, binding]);
	}
	return Object.fromEntries(entries);
}
