<div align="center">
  <img alt="logo" src="https://i.imgur.com/DK822L5.png" height="128" />
  <h1>RedditGrab</h1>
  <p>
    <a href="https://addons.mozilla.org/en-US/firefox/addon/media-downloader-redditgrab" target="_blank">
      <img alt="mozilla" src="https://img.shields.io/badge/Firefox-FF7139?style=for-the-badge&logo=Firefox-Browser&logoColor=white" />
    </a>
  </p>
</div>

Firefox extension for downloading images and videos from Reddit posts. Supports individual downloads and mass downloading with auto-scrolling.

## Preview

https://github.com/user-attachments/assets/4295d7c0-3b2f-450c-9ec5-53dab86b150d

![alt text](meta/preview-1.png)
![alt text](meta/preview-2.png)
![alt text](meta/preview-3.png)

## Features

- Individual post downloads via injected buttons
- Mass downloads with auto-scrolling
- Customizable download settings and folder organization
- Title overlay on images and videos
- Image processing with FFmpeg

## Usage

### Individual Downloads

1. Navigate to reddit.com
2. Click the blue "Download" button on any post
3. Media downloads automatically

### Mass Downloads

1. Open the RedditGrab sidebar panel
2. Configure download settings
3. Click "Start Mass Download"

### Settings

- **Download Folder**: Where files are saved (supports `{subreddit}`, `{date}`, `{user}`, `{title}`)
- **Filename Pattern**: File naming (supports `{subreddit}`, `{timestamp}`, `{title}`, `{filename}`)
- **Gallery Folders**: Separate folders for image galleries
- **Title Overlay**: Add post titles to media

## Development

Built with [WXT](https://wxt.dev/) and React.

### Prerequisites

- Node.js 22+
- pnpm

#### Commands

- `pnpm dev` - Development server (launches Firefox)
- `pnpm build` - Build to `.output/firefox-mv2/`
- `pnpm zip` - Create the distribution zip and a sources zip for AMO
- `pnpm sign` - Sign for self-distribution (unlisted); needs AMO API credentials
- `pnpm compile` - Typecheck

### Structure

```
entrypoints/
├── background.ts          # Background script
├── download-button.content/ # Content script
└── sidepanel/             # Sidebar UI
components/                # React components
utils/                     # Utilities
public/                    # Static assets
```

## Permissions

- `downloads` - Save files
- `activeTab` - Interact with Reddit
- `storage` - Save settings
- `tabs` - Query active tab

## Privacy

No data collection:

- No analytics
- No marketing data
- All media processing is local

## Building and installing it yourself

This fork is Firefox-only and is not published to a store.

```bash
pnpm install
pnpm zip          # .output/redditgrab-<version>-firefox.zip
```

**Before signing, change the extension id** in `wxt.config.ts`
(`browser_specific_settings.gecko.id`) — it still points at the upstream
author's AMO listing.

Then pick one:

- **Temporary (no signing):** `about:debugging#/runtime/this-firefox` →
  Load Temporary Add-on → `.output/firefox-mv2/manifest.json`. Gone on restart.
- **Permanent, stock Firefox:** sign as unlisted/self-distributed via AMO
  (`pnpm sign --api-key=… --api-secret=…`). Mozilla signs it; it never appears
  in the store.
- **Permanent, no signing:** run Firefox ESR, Developer Edition or Nightly and
  set `xpinstall.signatures.required` to `false` in `about:config`.

## Troubleshooting a download that didn't happen

Turn on **Debug logging** in the sidebar, then run the mass download. Every post
that is skipped or fails is logged with a reason code, and the sidebar offers
**Save diagnostics report** — a text file listing each post, which page layout
it came from (feed, search, or old.reddit), why it was skipped, and a permalink
back to it.
