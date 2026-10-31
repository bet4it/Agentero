# Account and team integration status

Settings retains a native account summary, cloud usage and a team list. Profile
editing and team management open the Web application. The unused local account
and organization screens, their adapters and their mutation hooks have been
removed. `src/features/account/` retains the auth client, session/team query
helpers, error mapping and the avatar primitive. Better Auth UI core supplies
query options; its React UI package is no longer needed.

`tauri-plugin-better-auth` 0.1.2 owns browser handoff, PKCE, native sessions, the
OS credential store and the Rust request bridge. The bridge limits requests to
configured auth/team routes. Local Vault use does not require an account.
Platform administration opens the Web application.

Local fixtures require both a Rust debug build with `AGENTERO_LOCAL_AUTH=1` and
Vite development with `VITE_AGENTERO_LOCAL_AUTH=1`. Production password login
remains disabled. Never deploy the Web repository's local-test Worker.

## Pending acceptance

On 2026-10-29 the user requested committing the current implementation to main
and stopping further testing. This is a work-in-progress integration, not a
completed release acceptance. Rust compilation and initial protocol checks ran,
but final frontend checks, native login/return, keychain persistence after restart,
multiple windows, offline behavior, team lifecycle, credential-store failures,
Windows/Linux validation and independent final review remain to be completed.
Do not create a release tag until these gates have been addressed.

Copied source attribution is recorded in `THIRD_PARTY.md`.
