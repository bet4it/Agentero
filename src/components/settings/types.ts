export type SettingsSection =
	| "account"
	| "plugins"
	| "general"
	| "appearance"
	| "agent"
	| "translate"
	| "layout"
	| "experimental"
	| "doctor"
	| "keyboard"
	| "remote-access"
	| "sync"
	| "about";

/** Which machine the Agent catalog / probe targets. */
export type SettingsHostContext =
	| { kind: "local" }
	| {
			kind: "remote";
			label: string;
			sessionId: string;
			host: string;
			remotePath: string;
	  };
