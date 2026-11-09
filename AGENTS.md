# Repository guidance

## Frontend motion contract

- Treat [docs/ui-motion-standard.md](docs/ui-motion-standard.md) as the canonical UI motion contract for the main workspace and server web UI.
- Use `web/motion.css` plus `web/motion.js`; reuse `uiMotion.openDialog`, `uiMotion.closeDialog`, shared navigation/segment highlights, and the anchored menu pattern before adding new motion.
- Keep the first render visible; animate only `transform`, `opacity`, `clip-path`, and SVG stroke drawing unless documenting a reviewed exception.
- Keyboard, `prefers-reduced-motion`, interruption, resize, and narrow-viewport behavior are part of the feature, not cleanup.
- Never load `motion.js` into `quick.html`; the quick collector stays lightweight.
- Update `scripts/verify-motion.cjs` when adding a reusable motion pattern or exception, and run it for UI motion changes.
