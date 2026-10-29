import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { withTauri } from "tauri-plugin-better-auth/client";

// The Rust bridge independently enforces its compile-time origin. This URL
// never enables an otherwise disallowed server or exports the credential.
export const accountApiOrigin =
	import.meta.env.DEV && import.meta.env.VITE_AGENTERO_LOCAL_AUTH === "1"
		? "http://localhost:8788"
		: "https://api.agentero.app";
export const accountWebOrigin = accountApiOrigin.startsWith("http:")
	? "http://localhost:5174"
	: "https://app.agentero.app";
export const authClient = createAuthClient(
	withTauri({
		baseURL: `${accountApiOrigin}/api/auth`,
		plugins: [organizationClient()],
	}),
);
