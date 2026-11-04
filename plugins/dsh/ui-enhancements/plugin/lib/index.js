/**
 * Host half of the macOS skin plugin.
 * Nothing to run server-side: this is a client-only (browser) package.
 * The Loader still imports the default entry, so export a no-op plugin body.
 */
export const name = "@local/dsh-ui-macos";

export function apply() {
  // The browser half (lib/client.js) owns all side effects.
}
