import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import {
	type CustomProperty_Serialize,
	commands,
	type PropertyOption_Serialize,
} from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { patchSettings, settingsStore } from "@/lib/settings/react-store";
import { getVaultPath } from "@/lib/vault/store";
import { setLibraryPapers } from "./library-store";

export type CustomProperty = CustomProperty_Serialize;
export type PropertyOption = PropertyOption_Serialize;
export type PropertyType = "select" | "text";

/** Read a property's type, defaulting legacy rows (no type) to `select`. */
export function propertyType(prop: CustomProperty): PropertyType {
	return prop.type === "text" ? "text" : "select";
}

type CustomPropertiesState = {
	properties: CustomProperty[];
	loading: boolean;
};

export const customPropertiesStore = createStore<CustomPropertiesState>(() => ({
	properties: [],
	loading: false,
}));

export function useCustomProperties(): CustomProperty[] {
	return useStore(customPropertiesStore, (s) => s.properties);
}

export function useCustomPropertiesLoading(): boolean {
	return useStore(customPropertiesStore, (s) => s.loading);
}

function errorText(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e ?? "Unknown error");
}

export async function loadCustomProperties(
	pathOverride?: string | null,
): Promise<void> {
	const vaultPath = pathOverride ?? getVaultPath();
	if (!vaultPath || !isTauri()) {
		customPropertiesStore.setState({ properties: [], loading: false });
		return;
	}
	customPropertiesStore.setState({ loading: true });
	try {
		const data = await callApi(() =>
			commands.catalogListProperties({ vaultPath }),
		);
		customPropertiesStore.setState({ properties: data, loading: false });
		const current = settingsStore.getState().libraryColumns;
		const missing = data
			.filter((p) => !current.some((c) => c.key === `prop:${p.id}`))
			.map((p) => ({
				key: `prop:${p.id}` as const,
				visible: true,
				widthRem: 9,
			}));
		if (missing.length > 0) {
			patchSettings({
				libraryColumns: [...current, ...missing],
			});
		}
	} catch (e) {
		notifyError(errorText(e));
		customPropertiesStore.setState({ loading: false });
	}
}

export async function createCustomProperty(
	name: string,
	type: PropertyType = "select",
	options: PropertyOption[] = [],
	vaultPathOverride?: string | null,
): Promise<CustomProperty | null> {
	const vaultPath = vaultPathOverride ?? getVaultPath();
	if (!vaultPath || !isTauri()) return null;
	try {
		const prop = await callApi(() =>
			commands.catalogCreateProperty({
				vaultPath,
				name,
				propertyType: type,
				options: options.map((o) => ({
					id: o.id,
					name: o.name,
					color: o.color ?? null,
				})),
			}),
		);
		customPropertiesStore.setState((s) => ({
			properties: [...s.properties, prop],
		}));
		// Add to visible columns by default
		const key = `prop:${prop.id}` as const;
		const current = settingsStore.getState().libraryColumns;
		if (!current.some((c) => c.key === key)) {
			patchSettings({
				libraryColumns: [...current, { key, visible: true, widthRem: 9 }],
			});
		}
		return prop;
	} catch (e) {
		notifyError(errorText(e));
		return null;
	}
}

export async function updateCustomProperty(
	property: CustomProperty,
): Promise<CustomProperty | null> {
	const vaultPath = getVaultPath();
	if (!vaultPath || !isTauri()) return null;
	try {
		const updated = await callApi(() =>
			commands.catalogUpdateProperty({
				vaultPath,
				property: {
					...property,
					options: property.options.map((o) => ({
						id: o.id,
						name: o.name,
						color: o.color ?? null,
					})),
				},
			}),
		);
		customPropertiesStore.setState((s) => ({
			properties: s.properties.map((p) => (p.id === updated.id ? updated : p)),
		}));
		return updated;
	} catch (e) {
		notifyError(errorText(e));
		return null;
	}
}

export async function deleteCustomProperty(
	propertyId: string,
): Promise<boolean> {
	const vaultPath = getVaultPath();
	if (!vaultPath || !isTauri()) return false;
	try {
		await callApi(() =>
			commands.catalogDeleteProperty({ vaultPath, propertyId }),
		);
		customPropertiesStore.setState((s) => ({
			properties: s.properties.filter((p) => p.id !== propertyId),
		}));
		// Remove from libraryColumns in settings
		const key = `prop:${propertyId}` as const;
		const current = settingsStore.getState().libraryColumns;
		if (current.some((c) => c.key === key)) {
			patchSettings({
				libraryColumns: current.filter((c) => c.key !== key),
			});
		}
		// Update local paper records in library store
		setLibraryPapers((prev) =>
			prev.map((paper) => {
				if (!paper.custom_props || !(propertyId in paper.custom_props))
					return paper;
				const nextProps = { ...paper.custom_props };
				delete nextProps[propertyId];
				return { ...paper, custom_props: nextProps };
			}),
		);
		return true;
	} catch (e) {
		notifyError(errorText(e));
		return false;
	}
}

export async function setPaperCustomProperty(
	paperPath: string,
	propertyId: string,
	value: string | null,
): Promise<boolean> {
	const vaultPath = getVaultPath();
	if (!vaultPath || !isTauri()) return false;
	try {
		await callApi(() =>
			commands.catalogSetPaperProperty({
				vaultPath,
				paperPath,
				propertyId,
				optionId: value,
			}),
		);
		setLibraryPapers((prev) =>
			prev.map((p) => {
				if (p.path !== paperPath) return p;
				const custom_props = { ...(p.custom_props ?? {}) };
				const trimmed = value?.trim();
				if (trimmed) {
					custom_props[propertyId] = trimmed;
				} else {
					delete custom_props[propertyId];
				}
				return { ...p, custom_props };
			}),
		);
		return true;
	} catch (e) {
		notifyError(errorText(e));
		return false;
	}
}

export async function createOptionAndSetCustomProperty(
	paperPath: string,
	propertyId: string,
	optionName: string,
	optionColor: string | null = null,
): Promise<boolean> {
	const vaultPath = getVaultPath();
	if (!vaultPath || !isTauri()) return false;
	try {
		const res = await callApi(() =>
			commands.catalogCreateOptionAndSet({
				vaultPath,
				paperPath,
				propertyId,
				optionName,
				optionColor,
			}),
		);
		const { property, paper } = res;
		customPropertiesStore.setState((s) => ({
			properties: s.properties.map((p) =>
				p.id === property.id ? property : p,
			),
		}));
		setLibraryPapers((prev) =>
			prev.map((p) =>
				p.path === paperPath ? { ...p, custom_props: paper.custom_props } : p,
			),
		);
		return true;
	} catch (e) {
		notifyError(errorText(e));
		return false;
	}
}

export async function deleteCustomPropertyOption(
	propertyId: string,
	optionId: string,
): Promise<boolean> {
	const vaultPath = getVaultPath();
	if (!vaultPath || !isTauri()) return false;
	try {
		const updated = await callApi(() =>
			commands.catalogDeletePropertyOption({
				vaultPath,
				propertyId,
				optionId,
			}),
		);
		customPropertiesStore.setState((s) => ({
			properties: s.properties.map((p) => (p.id === updated.id ? updated : p)),
		}));
		setLibraryPapers((prev) =>
			prev.map((paper) => {
				if (paper.custom_props?.[propertyId] === optionId) {
					const nextProps = { ...paper.custom_props };
					delete nextProps[propertyId];
					return { ...paper, custom_props: nextProps };
				}
				return paper;
			}),
		);
		return true;
	} catch (e) {
		notifyError(errorText(e));
		return false;
	}
}
