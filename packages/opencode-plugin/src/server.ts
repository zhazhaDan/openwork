import { createPlugin } from "./plugin.ts"
import { initializeDesktopCredentialChannel } from "./desktop-credential-channel.ts"

// Credential delivery may remain open on some hosts. The broker's fetch methods
// await the same initialization promise, so plugin activation must not wait here.
void initializeDesktopCredentialChannel().catch(() => {})

/** OpenCode V2 plugin entry (`Plugin.define` shape: `{ id, setup }`). */
export default createPlugin()
