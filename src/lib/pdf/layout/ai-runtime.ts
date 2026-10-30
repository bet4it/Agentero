import type { AiRuntime } from "@embedpdf/ai";
import { createAiRuntime } from "@embedpdf/ai/web";

import { isTauri } from "@/lib/core/tauri";
import { layoutModelLocalUrl } from "@/lib/pdf/layout/model";

/**
 * Shared browser AI runtime for EmbedPDF layout analysis.
 * Created once: loads ONNX Runtime on demand.
 *
 * In Tauri, the ONNX file lives under XDG cache
 * (`$XDG_CACHE_HOME/agentero/models/pp-doclayoutv3.onnx`), prefetched at
 * app startup (ModelScope first, HuggingFace fallback) and served via the
 * `agentero-model` custom protocol. Browser Cache API is disabled so we do
 * not double-cache the Host-managed file.
 */
let runtime: AiRuntime | null = null;

export function getPdfAiRuntime(): AiRuntime {
	if (!runtime) {
		const models = isTauri()
			? {
					"layout-detection": {
						url: layoutModelLocalUrl(),
					},
				}
			: undefined;
		const shared = createAiRuntime({
			backend: "auto",
			// Disk-managed in Tauri; keep Cache API only for plain browser.
			cache: !isTauri(),
			models,
		});
		// Viewer unmount and the headless registry both call `runtime.destroy()`,
		// which releases the ONNX session. A second in-flight layout job then
		// fails with "cannot run inference. invalid session id". This runtime
		// lives for the app; plugin teardown must not drop it.
		runtime = new Proxy(shared, {
			get(target, prop, receiver) {
				if (prop === "destroy") return () => Promise.resolve();
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as AiRuntime;
	}
	return runtime;
}
