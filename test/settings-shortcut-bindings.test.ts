import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";
import {
	normalizeShortcutOverrides,
	type ShortcutOverrides,
} from "@/lib/settings/shortcut-bindings";

const host = vi.hoisted(() => ({
	settings: {} as Record<string, unknown>,
	existed: true,
	listeners: [] as ((event: { payload: unknown }) => void)[],
}));

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/core", () => ({
	Channel: class {},
	invoke: async (command: string, args?: { settings: unknown }) => {
		if (command === "settings_set") {
			host.settings = JSON.parse(JSON.stringify(args?.settings));
			return { ok: true, data: host.settings };
		}
		return {
			ok: true,
			data: {
				settings: host.settings,
				existed: host.existed,
				path: "/tmp/settings.json",
			},
		};
	},
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: async (
		name: string,
		listener: (event: { payload: unknown }) => void,
	) => {
		if (name === "settings:changed") host.listeners.push(listener);
		return () => {};
	},
}));

const overrides: ShortcutOverrides = {
	"workspace.search": {
		key: "K",
		meta: true,
		ctrl: false,
		alt: true,
		shift: true,
	},
	"workspace.close": null,
};

beforeEach(() => {
	vi.resetModules();
	host.settings = {};
	host.existed = true;
	host.listeners = [];
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("shortcut override normalization", () => {
	it("keeps bindings and disabled commands without sharing binding objects", () => {
		const normalized = normalizeShortcutOverrides(overrides);
		expect(normalized).toEqual(overrides);
		expect(normalized["workspace.search"]).not.toBe(
			overrides["workspace.search"],
		);
		expect(normalizeShortcutOverrides({ space: { key: " " } })).toEqual({
			space: { key: " " },
		});
	});

	it("drops malformed entries and unknown fields without interpreting command ids", () => {
		expect(
			normalizeShortcutOverrides({
				futureCommand: { key: "F12", extra: "ignored" },
				missingKey: { meta: true },
				emptyKey: { key: "" },
				numericKey: { key: 4 },
				invalidModifier: { key: "K", ctrl: "true" },
				nullModifier: { key: "K", alt: null },
				array: [],
				primitive: false,
				" ": null,
			}),
		).toEqual({ futureCommand: { key: "F12" } });
		for (const raw of [undefined, null, [], false, "invalid", 42, new Date()]) {
			expect(normalizeShortcutOverrides(raw)).toEqual({});
		}
	});

	it("does not consume inherited entries or mutate object prototypes", () => {
		expect(
			normalizeShortcutOverrides(Object.create({ inherited: null })),
		).toEqual({});
		const normalized = normalizeShortcutOverrides(
			JSON.parse('{"__proto__":{"key":"K"},"constructor":null}'),
		);
		expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
		expect(Object.hasOwn(normalized, "__proto__")).toBe(true);
		expect(normalized.constructor).toBeNull();
	});
});

describe("shortcut settings persistence", () => {
	it("round-trips through Host settings and isolates saved and loaded snapshots", async () => {
		const store = await import("@/lib/settings/store");
		await store.ensureSettingsLoaded();
		const input = {
			...DEFAULT_SETTINGS,
			shortcutOverrides: structuredClone(overrides),
		};
		const saved = await store.saveSettingsAsync(input);
		expect(host.settings.shortcutOverrides).toEqual(overrides);
		expect(saved.shortcutOverrides).toEqual(overrides);
		const savedBinding = saved.shortcutOverrides["workspace.search"];
		if (savedBinding) savedBinding.key = "Z";

		const inputBinding = input.shortcutOverrides["workspace.search"];
		if (inputBinding) inputBinding.key = "X";
		const snapshot = store.loadSettings();
		const snapshotBinding = snapshot.shortcutOverrides["workspace.search"];
		if (snapshotBinding) snapshotBinding.key = "Y";
		expect(store.loadSettings().shortcutOverrides).toEqual(overrides);

		vi.resetModules();
		const reloaded = await import("@/lib/settings/store");
		expect((await reloaded.ensureSettingsLoaded()).shortcutOverrides).toEqual(
			overrides,
		);
	});

	it("defaults older Host settings to empty overrides without losing preferences", async () => {
		host.settings = { theme: "dark", locale: "zh-CN" };
		const store = await import("@/lib/settings/store");
		const settings = await store.ensureSettingsLoaded();
		expect(settings.shortcutOverrides).toEqual({});
		expect(settings.theme).toBe("dark");
		await store.saveSettingsAsync(settings);
		expect(host.settings.shortcutOverrides).toEqual({});
		expect(host.settings.locale).toBe("zh-CN");
	});

	it("migrates legacy localStorage settings with default shortcut overrides", async () => {
		host.existed = false;
		const removeItem = vi.fn();
		vi.stubGlobal("localStorage", {
			getItem: () => JSON.stringify({ theme: "dark" }),
			removeItem,
		});
		const store = await import("@/lib/settings/store");
		const settings = await store.ensureSettingsLoaded();
		expect(settings.shortcutOverrides).toEqual({});
		expect(host.settings.theme).toBe("dark");
		expect(host.settings.shortcutOverrides).toEqual({});
		expect(removeItem).toHaveBeenCalledWith("agentero-settings");
	});

	it("notifies local saves before Host echoes so other settings panes preserve bindings", async () => {
		const store = await import("@/lib/settings/store");
		await store.ensureSettingsLoaded();
		const listener = vi.fn();
		const unsubscribe = store.subscribeSettings(listener);
		const next = {
			...store.loadSettings(),
			shortcutOverrides: structuredClone(overrides),
		};
		store.saveSettings(next);
		expect(listener).toHaveBeenCalledWith(
			expect.objectContaining({ shortcutOverrides: overrides }),
		);
		listener.mockClear();
		const saved = store.saveSettingsAsync({
			...store.loadSettings(),
			theme: "dark",
		});
		expect(listener).toHaveBeenCalledWith(
			expect.objectContaining({ theme: "dark", shortcutOverrides: overrides }),
		);
		await saved;
		unsubscribe();
	});

	it("normalizes Host broadcasts and notifies existing settings subscribers", async () => {
		const store = await import("@/lib/settings/store");
		await store.ensureSettingsLoaded();
		const listener = vi.fn();
		const unsubscribe = store.subscribeSettings(listener);
		store.initSettingsSync();
		await vi.waitFor(() => expect(host.listeners).toHaveLength(1));
		host.listeners[0]({
			payload: {
				...DEFAULT_SETTINGS,
				shortcutOverrides: { ...overrides, invalid: { key: 3 } },
			},
		});
		expect(store.loadSettings().shortcutOverrides).toEqual(overrides);
		expect(listener).toHaveBeenCalledWith(
			expect.objectContaining({ shortcutOverrides: overrides }),
		);
		unsubscribe();
	});
});
