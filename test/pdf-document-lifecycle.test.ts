import { createRequire } from "node:module";
import { createPluginRegistration, PluginRegistry } from "@embedpdf/core";
import {
	type PdfDocumentObject,
	type PdfEngine,
	PdfTaskHelper,
	Task,
} from "@embedpdf/models";
import {
	type DocumentManagerPlugin,
	DocumentManagerPluginPackage,
} from "@embedpdf/plugin-document-manager";
import { describe, expect, it, vi } from "vitest";

const doc = (id: string) =>
	({ id, pageCount: 0, pages: [] }) as unknown as PdfDocumentObject;

async function mountRegistry(
	engine: PdfEngine,
	id: string,
	plugin: typeof DocumentManagerPluginPackage,
) {
	const registry = new PluginRegistry(engine, {});
	registry.registerPluginBatch([
		createPluginRegistration(plugin, {
			initialDocuments: [
				{ documentId: id, name: id, buffer: new ArrayBuffer(8) },
			],
		}),
	]);
	await registry.initialize();
	const manager = registry.getPlugin<DocumentManagerPlugin>("document-manager");
	if (!manager) throw new Error("Document Manager did not initialize");
	const scope = manager.provides();
	return { registry, scope };
}

function deferredEngine() {
	const pending = new Task<PdfDocumentObject, unknown>();
	const close = vi.fn(() => PdfTaskHelper.resolve(true));
	const engine = {
		openDocumentBuffer: vi.fn(() => pending),
		closeDocument: close,
	} as unknown as PdfEngine;
	return { pending, close, engine };
}

const cjsPackage = createRequire(import.meta.url)(
	"@embedpdf/plugin-document-manager",
).DocumentManagerPluginPackage as typeof DocumentManagerPluginPackage;

describe.each([
	["ESM", DocumentManagerPluginPackage],
	["CJS", cjsPackage],
] as const)("PDF document ownership during asynchronous loading (%s)", (_entry, plugin) => {
	const mount = (engine: PdfEngine, id: string) =>
		mountRegistry(engine, id, plugin);
	it("closes a load that succeeds after its registry starts unmounting", async () => {
		const { pending, close, engine } = deferredEngine();
		const { registry } = await mount(engine, "late");
		const destroyed = registry.destroy();
		await Promise.resolve();
		expect(close).not.toHaveBeenCalled();
		pending.resolve(doc("late"));
		await destroyed;
		expect(close).toHaveBeenCalledExactlyOnceWith(doc("late"));
	});

	it("settles teardown when a pending load fails without closing a missing document", async () => {
		const { pending, close, engine } = deferredEngine();
		const { registry, scope } = await mount(engine, "failed");
		const errors = vi.fn();
		scope.onDocumentError(errors);
		const destroyed = registry.destroy();
		await Promise.resolve();
		pending.reject(new Error("allocation failed"));
		await destroyed;
		expect(close).not.toHaveBeenCalled();
		expect(errors).not.toHaveBeenCalled();
	});

	it("shares an in-flight close so repeated requests release only one owner", async () => {
		const { pending, close, engine } = deferredEngine();
		const closing = new Task<boolean, unknown>();
		close.mockReturnValue(closing);
		const { registry, scope } = await mount(engine, "once");
		pending.resolve(doc("once"));
		const first = scope.closeDocument("once");
		const second = scope.closeDocument("once");
		expect(close).toHaveBeenCalledOnce();
		closing.resolve(true);
		await Promise.all([first.toPromise(), second.toPromise()]);
		await registry.destroy();
		expect(close).toHaveBeenCalledOnce();
	});

	it("releases a cancelled owner's late load without closing another pane's owner", async () => {
		const first = new Task<PdfDocumentObject, unknown>();
		const second = new Task<PdfDocumentObject, unknown>();
		let owners = 0;
		const engine = {
			openDocumentBuffer: vi
				.fn()
				.mockReturnValueOnce(first)
				.mockReturnValueOnce(second),
			closeDocument: vi.fn(() => {
				owners--;
				return PdfTaskHelper.resolve(true);
			}),
		} as unknown as PdfEngine;
		const a = await mount(engine, "shared");
		const unmountA = a.registry.destroy();
		await Promise.resolve();
		const b = await mount(engine, "shared");
		owners++;
		first.resolve(doc("shared"));
		await unmountA;
		owners++;
		second.resolve(doc("shared"));
		expect(owners).toBe(1);
		expect(b.scope.getDocument("shared")?.id).toBe("shared");
		await b.registry.destroy();
		expect(owners).toBe(0);
	});
});
