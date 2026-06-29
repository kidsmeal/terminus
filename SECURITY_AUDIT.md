```
Git Gud Security — full scan · neon-term

  Grade: C     0 critical · 3 high · 3 medium · 2 low

HIGH
 1. CSP disabled — webview runs with no Content Security Policy   tauri.conf.json:26
    "csp": null removes all script/style/connect restrictions; any injected script
    runs unrestricted in the webview context which has IPC access (see #2).
    fix: Set a restrictive CSP: "csp": "default-src 'self'; style-src 'self' 'unsafe-inline'
    https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'"

 2. withGlobalTauri exposes IPC to all page scripts              tauri.conf.json:13
    withGlobalTauri:true puts window.__TAURI__ on every script context. Combined
    with no CSP (#1), any injected script can call invoke("pty_spawn"),
    invoke("pty_write", ...) and get a live shell on the host.
    fix: Set withGlobalTauri:false, import @tauri-apps/api only from your own
    bundled modules. Or keep it, but the CSP fix in #1 becomes mandatory.

 3. Tauri FS + shell plugin grants broader surface than needed    package.json:17, capabilities/default.json
    @tauri-apps/plugin-shell is listed as a dependency but never imported or used
    in code. It widens the attack surface for no reason. The FS plugin is properly
    scoped to $APPDATA/** which is correct.
    fix: Remove @tauri-apps/plugin-shell from package.json and Cargo.toml
    (tauri-plugin-shell if present). Only ship plugins you use.

MEDIUM
 4. No PTY ID ownership validation in Tauri commands             src-tauri/src/lib.rs:75
    pty_write, pty_resize, pty_kill accept any u32 id from the frontend. In a
    single-window app this is low risk, but the commands do no sender/origin
    validation — a rogue script (enabled by #1+#2) can write to any open PTY.
    fix: Not urgent given single-window, but if you add multi-window or remote
    content, validate the requesting window against PTY ownership.

 5. External CDN resource loaded without SRI                     src/styles.css:1
    @import url('https://fonts.googleapis.com/css2?...') loads a remote stylesheet
    with no Subresource Integrity hash. A CDN compromise could inject CSS-based
    data exfiltration (e.g. font-face unicode-range timing) or break rendering.
    fix: Self-host the font files in your assets, or add an SRI hash. Self-hosting
    is better for a desktop app — it removes the network dependency entirely.

 6. Duplicate xterm dependency                                   package.json:19-20
    Both "xterm": "^5.3.0" (old, deprecated) and "@xterm/xterm": "^6.0.0" (current)
    are listed. The old package is unmaintained and receives no security patches.
    Only @xterm/xterm is imported in code.
    fix: Remove "xterm": "^5.3.0" from dependencies.

LOW
 7. .expect() panics on PTY failure crash the app               src-tauri/src/lib.rs:33-41
    pty_spawn uses .expect() on openpty, spawn_command, take_writer, try_clone_reader.
    A failure (e.g. resource exhaustion) panics the thread and may crash the whole
    app or leave it in a broken state.
    fix: Return a Result from pty_spawn and surface errors to the frontend gracefully.

 8. No Dependabot / Renovate or CI audit configured              repo root
    No .github/dependabot.yml, no renovate.json, no CI audit step visible.
    Vulnerabilities in transitive deps will accumulate silently.
    fix: Add dependabot.yml for npm + cargo ecosystems, or renovate.json.

couldnt check in full (run ultra to go deeper):
 · git history for previously committed secrets
 · whether portable-pty 0.8 has known CVEs (no advisory DB check run)
 · runtime behavior of WebView2 CSP enforcement on Windows
 · build output (dist/) for inlined secrets or source maps

scanned: src-tauri/src/lib.rs, src-tauri/src/main.rs, src-tauri/tauri.conf.json,
src-tauri/Cargo.toml, src-tauri/build.rs, src-tauri/capabilities/default.json,
src-tauri/.gitignore, src/main.ts, src/styles.css, index.html, package.json,
.gitignore, tsconfig.json, vite.config.ts  ·  14 files  ·  checks: secrets,
desktop-apps, injection, web-frontend, dependencies
```
