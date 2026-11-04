import type { WxtViteConfig } from "wxt";

// vite is WXT's dependency, not ours, so its types are reached through WXT.
type Plugin = Extract<
  NonNullable<WxtViteConfig["plugins"]>[number],
  { name: string }
>;

/**
 * Make the HTML entrypoints' asset references work on a Firefox extension page.
 *
 * Vite stamps `crossorigin` on the <script> and <link> tags it injects. On a
 * moz-extension:// page that turns the stylesheet into a CORS request for a
 * resource that is not web-accessible, and the load is dropped — silently, with
 * nothing in the page to show for it. The sidebar rendered as bare HTML:
 * default serif headings, numbered list markers, no Tailwind at all, while the
 * React bundle beside it loaded and ran. Nothing here is cross-origin, so the
 * attribute has never bought anything.
 *
 * The stylesheet is inlined as well. It carries no url() references, so there
 * is nothing to rewrite, it is ~48KB, and a <style> element cannot fail to
 * fetch. Inline styles are allowed: the extension CSP sets script-src and
 * object-src and says nothing about styles.
 */
export function firefoxHtmlAssets(): Plugin {
  return {
    name: "redditgrab:firefox-html-assets",
    apply: "build",
    enforce: "post",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const withoutCors = html.replace(
          /\s+crossorigin(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/g,
          "",
        );

        return withoutCors.replace(
          /<link\b[^>]*\brel="stylesheet"[^>]*>/g,
          (tag) => {
            const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
            // Leave anything remote, or anything we can't find in the bundle,
            // exactly as Vite wrote it.
            if (!href || /^[a-z]+:/i.test(href)) return tag;

            const asset = ctx.bundle?.[href.replace(/^\/+/, "")];
            if (!asset || asset.type !== "asset") return tag;

            const css =
              typeof asset.source === "string"
                ? asset.source
                : Buffer.from(asset.source).toString("utf8");
            // The CSS is minified by this point, so it contains no "</".
            return `<style>${css}</style>`;
          },
        );
      },
    },
  };
}
