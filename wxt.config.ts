import { defineConfig, WxtViteConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react", "@wxt-dev/auto-icons"],
  // Firefox-only build. The Chrome/MV3 path needed an offscreen document to run
  // ffmpeg.wasm, reached over a message round-trip; that document was never
  // closed, so every blob URL and ffmpeg heap it created accumulated for the
  // session. Firefox's persistent background page does the same work directly.
  browser: "firefox",
  manifestVersion: 2,
  // Open a Reddit page on `wxt dev` so the content script loads immediately.
  webExt: {
    startUrls: ["https://www.reddit.com"],
  },
  manifest: () => ({
    name: "Downloader for Reddit - RedditGrab",
    description:
      "Download images and videos from Reddit posts (including Redgifs)",
    // version is auto-read from package.json by WXT
    // "offscreen" is gone with the Chrome path it existed for.
    permissions: ["downloads", "activeTab", "storage", "tabs"],
    host_permissions: [
      "*://*.reddit.com/*",
      "*://*.redd.it/*",
      "*://*.redgifs.com/*",
      "*://api.redgifs.com/*",
    ],
    // Explicit Gecko ID avoids Firefox reporting a signed XPI as corrupt.
    //
    // CHANGE THIS BEFORE SIGNING. The id below is the upstream author's AMO
    // listing; reusing it means AMO rejects the submission and Firefox may
    // treat this build as a conflicting install of theirs. Any unique value
    // works — an email-style id is fine:
    //   id: "redditgrab@erasnier.local"
    browser_specific_settings: {
      gecko: {
        id: "{d6ae963b-906b-4ebe-9d91-ef1cb6f770c9}",
        // Required for new AMO submissions. This extension collects nothing:
        // no analytics, no telemetry, all media processing is local.
        // https://mzl.la/firefox-builtin-data-consent
        data_collection_permissions: {
          required: ["none"],
        },
      },
    },
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
      sandbox:
        "sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; child-src 'self';",
    },
    web_accessible_resources: [
      {
        matches: ["<all_urls>"],
        resources: ["ffmpeg/*"],
      },
    ],
    // Enable extension icon click without a popup (MV2).
    browser_action: {},
  }),
  vite: () =>
    ({
      plugins: [tailwindcss(), wasm(), topLevelAwait()],
      optimizeDeps: {
        exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
      },
      server: {
        headers: {
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
        },
      },
    }) as WxtViteConfig,
});
