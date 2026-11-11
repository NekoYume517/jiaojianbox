# Repository guidance

## Local toolchains

- Windows Go compiler: `E:\tools\go\bin\go.exe` (Go 1.26.10). It is installed permanently and registered in the user PATH/GOROOT. Use this compiler instead of downloading another copy; existing running terminals may need their environment refreshed.

## UI and motion contract

- Read [docs/ui-design-standard.md](docs/ui-design-standard.md) before creating or changing any UI. It is the single source for visual design, layout, spacing, controls, responsive behavior, feedback, motion and acceptance. The old motion document is a compatibility link only.
- For a fresh implementation, run the self-contained reference embedded in section 13 of that document (also available as docs/ui-reference.html). Match its exact tokens and components before adding business UI. Do not regenerate the frozen reference from changing app styles to make a visual regression pass.
- Reuse the existing semantic colors and density tokens. Keep sidebar settings above the bottom account area, preserve mobile navigation labels, and use the shared custom file-picker controls.
- Keep one moving highlight per tab group; unselected sidebar/tab hover changes text only. Preserve shared DOM identity, form drafts and subsection scroll position. Use uiMotion.relayout for shared layout elements rather than rebuilding the whole view.
- Use `web/motion.css` plus `web/motion.js`; reuse `uiMotion.openDialog`, `uiMotion.closeDialog`, shared navigation/segment highlights, and the anchored menu pattern before adding new motion.
- Keep the first render visible; animate only `transform`, `opacity`, `clip-path`, and SVG stroke drawing unless documenting a reviewed exception.
- Keyboard, `prefers-reduced-motion`, interruption, resize, and narrow-viewport behavior are part of the feature, not cleanup.
- Never load `motion.js` into `quick.html`; the quick collector stays lightweight.
- Android online UI uses the shared `web/` workspace in WebView. Only the login gate and system connector surfaces use native Material 3; see docs/android-web-shell.md. Do not rebuild the online workspace as independent Compose pages.
- Update `scripts/verify-motion.cjs` when adding a reusable motion pattern or exception, and run it for UI motion changes.
