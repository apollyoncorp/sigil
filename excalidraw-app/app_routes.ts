/**
 * Paths, besides `/`, that the app is served on.
 *
 * Adding a path here lets the service worker serve the cached app for it
 * (see `navigateFallbackAllowlist` in vite.config.mts). The host must serve
 * the app for it too, or the path is a 404.
 *
 * Sigil: empty since the Excalidraw+ export route was removed.
 */
export const APP_ROUTES: Record<string, string> = {};
