Git Gud Security — ultra scan · terminus

  Grade: A     0 critical · 0 high · 0 medium · 1 low

LOW
 1. innerHTML without escaping on tab/folder names          src/main.ts:257,287
    tab.name and folder.name interpolated into innerHTML without escapeHtml().
    CSP script-src 'self' blocks inline script execution, and names are self-authored
    by the local user or loaded from their own AppData/state.json, so this is not
    practically exploitable. The project panel (line 827+) correctly uses escapeHtml().
    fix: pass tab.name and folder.name through escapeHtml() for consistency.

couldnt fully confirm in ultra:
 · git history secrets (shallow clone, no full history scan)

what the scan verified clean:
 · no hardcoded secrets, API keys, or credentials anywhere in the repo
 · no .env files committed; .gitignore covers the right things
 · tauri.conf.json: withGlobalTauri:false, CSP present with script-src 'self'
 · capabilities/default.json: fs scoped to $APPDATA only (read/write/exists/mkdir)
 · no shell plugin, no http plugin, no broad fs scope
 · Rust backend: PTY commands (spawn/write/resize/kill) are inherent terminal behavior,
   not an escalation. project_scan/project_watch read .md files from a user-supplied
   path but this is a local desktop app where the user already has a shell.
 · escapeHtml() correctly used on all project panel content (NOW.md, plans, shipped)
 · no eval(), no dynamic require/import, no command injection beyond intended PTY
 · package-lock.json and Cargo.lock both present
 · no CI/CD pipelines to audit
 · context-menu scripts: registry writes are to HKCU (user-scoped), paths are
   resolved from the binary location, %V is shell-expanded by Explorer (not injectable)

scanned: src/main.ts, src/styles.css, src-tauri/src/lib.rs, src-tauri/src/project.rs,
src-tauri/src/main.rs, src-tauri/build.rs, src-tauri/tauri.conf.json,
src-tauri/capabilities/default.json, src-tauri/Cargo.toml, package.json,
index.html, .gitignore, vite.config.ts, tsconfig.json, README.md,
scripts/context-menu-install.ps1, scripts/context-menu-uninstall.ps1,
.vscode/extensions.json  ·  18 files  ·  ultra (4 rounds, 238 agents, adversarial verify)
