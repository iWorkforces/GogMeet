import { BrowserWindow, app, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageInfo } from "../utils/packageInfo.js";
import { existsSync, readFileSync } from "node:fs";
import { SECURE_WEB_PREFERENCES } from "../utils/browser-window.js";
import { bindWindowsThemeBackground, platformWindowChrome } from "../utils/window-chrome.js";
import { escapeHtml } from "../../shared/utils/escape-html.js";
import { APP_ICON_AURORA_CSS, appIconWithAuroraHtml } from "../../shared/utils/app-icon-aurora.js";
import { acquireDockVisibility, releaseDockVisibility } from "./dock-visibility.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Reference to the cached About BrowserWindow (null only after force destroy). */
let aboutWindow: BrowserWindow | null = null;
let unbindAboutTheme: (() => void) | null = null;
/** Whether this module currently holds a Dock visibility claim. */
let aboutDockHeld = false;

/**
 * Sentinel URL used only to request close from the sandboxed about page.
 * Close is wired from main via executeJavaScript + this sentinel (intercepted;
 * never loads). Page CSP uses script-src 'none'; main-process executeJavaScript
 * is not gated by page CSP.
 */
const ABOUT_CLOSE_URL = "https://gogmeet.local/__about_close__";

/**
 * Built main: lib/main → ../../src/assets; Vitest source: src/main/windows → ../../../assets.
 */
function resolveAboutIconSvgPath(): string {
  const candidates = [
    path.join(__dirname, "..", "..", "src", "assets", "about-icon.svg"),
    path.join(__dirname, "..", "..", "..", "assets", "about-icon.svg"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0]!;
}

let aboutIconDataUriCache: string | null = null;
function getAboutIconDataUri(): string {
  if (aboutIconDataUriCache !== null) {
    return aboutIconDataUriCache;
  }
  const aboutIconSvg = readFileSync(resolveAboutIconSvgPath(), "utf-8");
  aboutIconDataUriCache = `data:image/svg+xml,${encodeURIComponent(aboutIconSvg)}`;
  return aboutIconDataUriCache;
}

declare module "electron" {
  interface BrowserWindow {
    /** When true, close proceeds to destroy instead of hide-cache. */
    __forceDestroy?: boolean;
  }
}

function holdAboutDock(): void {
  if (aboutDockHeld) return;
  aboutDockHeld = true;
  acquireDockVisibility();
}

function releaseAboutDock(): void {
  if (!aboutDockHeld) return;
  aboutDockHeld = false;
  releaseDockVisibility();
}

/** Hide (cache) the About window; used for Close button and Escape. */
function hideAboutWindow(win: BrowserWindow): void {
  if (!win.isDestroyed() && win.isVisible()) {
    win.hide();
  }
  releaseAboutDock();
}

/** Allow only https repository URLs for shell.openExternal. */
export function isSafeAboutRepositoryUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function escapeAttr(str: string): string {
  return escapeHtml(str);
}

/** Drop keyboard focus from any control so present does not ring the GitHub link. */
function blurAboutPageFocus(win: BrowserWindow): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  void win.webContents
    .executeJavaScript(
      "requestAnimationFrame(function(){var el=document.activeElement;if(el instanceof HTMLElement)el.blur();})",
    )
    .catch(() => undefined);
}

function presentAboutWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (!win.isVisible()) {
    win.show();
  }
  // Always claim Dock while this dialog is presented (idempotent).
  holdAboutDock();
  // Window focus only — no control should hold keyboard focus on present.
  win.focus();
  blurAboutPageFocus(win);
}

/**
 * Shows the About window. First call builds data: HTML once; later calls
 * re-show the cached BrowserWindow (instant).
 */
export function showAbout(_mainWindow: BrowserWindow): void {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    presentAboutWindow(aboutWindow);
    return;
  }

  const packageJson = getPackageInfo();
  const version = escapeHtml(app.getVersion());
  const appName = escapeHtml(app.getName());
  const description = escapeHtml(packageJson.description);
  const author = escapeHtml(packageJson.author);
  const year = new Date().getFullYear();
  const rawRepo = packageJson.repository;
  const repoSafe = isSafeAboutRepositoryUrl(rawRepo) ? rawRepo : "";
  const repoAttr = escapeAttr(repoSafe);
  const repoHref =
    repoSafe.length > 0
      ? `href="${repoAttr}" target="_blank" rel="noopener noreferrer"`
      : `href="#" aria-disabled="true"`;

  // Classic macOS About box. data: HTML (no preload / loadWindowContent).
  // CSP meta: script-src 'none' (main executeJavaScript still wires Close).
  const html = `\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'">
<title>About ${appName}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    color-scheme: dark;
    --bg: #0d1117;
    --bg-solid: #0d1117;
    --text-primary: #f5f5f7;
    --text-secondary: #ebebf5;
    --text-tertiary: #98989d;
    --control-fill: rgba(255, 255, 255, 0.1);
    --control-fill-hover: rgba(255, 255, 255, 0.14);
    --control-border: rgba(255, 255, 255, 0.14);
    --accent: #0a84ff;
    --edge: rgba(255, 255, 255, 0.08);
    --traffic-safe: 40px;
  }
  @media (prefers-contrast: more) {
    :root {
      --text-secondary: var(--text-primary);
      --text-tertiary: var(--text-primary);
      --control-border: var(--text-primary);
    }
  }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif;
    background: #0d1117;
    color: var(--text-primary);
    display: flex;
    flex-direction: column;
    align-items: center;
    height: 100vh;
    -webkit-app-region: drag;
    user-select: none;
    -webkit-user-select: none;
    -webkit-font-smoothing: antialiased;
    padding: var(--traffic-safe) 28px 16px;
    position: relative;
  }
  body::before {
    content: "";
    position: absolute;
    inset: 0 0 auto 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--edge), transparent);
    pointer-events: none;
  }
  .stage {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    margin-top: 8px;
    /* Strong ease-out; content settles under the aurora bloom */
    animation: about-in 0.28s cubic-bezier(0.23, 1, 0.32, 1) both;
  }
  @keyframes about-in {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .stage { animation: none; }
  }
  ${APP_ICON_AURORA_CSS}
  .app-icon-aurora--about {
    margin-bottom: 18px;
  }
  h1 {
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.025em;
    line-height: 1.15;
    margin-bottom: 6px;
    color: var(--text-primary);
  }
  .version {
    font-size: 12px;
    font-weight: 400;
    letter-spacing: 0.01em;
    color: var(--text-secondary);
    margin-bottom: 10px;
    line-height: 1.3;
  }
  .copyright {
    font-size: 11px;
    font-weight: 400;
    color: var(--text-tertiary);
    text-align: center;
    line-height: 1.45;
    letter-spacing: 0.01em;
    max-width: 260px;
    margin-bottom: 8px;
  }
  .blurb {
    font-size: 11px;
    font-weight: 400;
    color: var(--text-tertiary);
    text-align: center;
    line-height: 1.4;
    max-width: 260px;
    margin-bottom: 14px;
  }
  .actions {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    -webkit-app-region: no-drag;
    width: 100%;
  }
  .repo-link {
    font-size: 12px;
    font-weight: 500;
    color: var(--accent);
    text-decoration: none;
    letter-spacing: -0.01em;
    padding: 4px 8px;
    border-radius: 6px;
    transition: opacity 0.12s ease-out, transform 0.1s ease-out;
  }
  .repo-link:hover { opacity: 0.85; }
  .repo-link:active { transform: scale(0.97); opacity: 0.75; }
  .repo-link:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .repo-link[aria-disabled="true"] {
    opacity: 0.4;
    pointer-events: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .repo-link { transition: none; }
    .repo-link:active { transform: none; }
  }
</style>
</head>
<body>
  <div class="stage">
    ${appIconWithAuroraHtml(getAboutIconDataUri(), { size: 96, className: "app-icon-aurora--about" })}
    <h1>${appName}</h1>
    <p class="version">Version ${version}</p>
    <p class="copyright">Copyright © ${year} ${author}</p>
    <p class="blurb">${description}</p>
    <div class="actions">
      <a class="repo-link" ${repoHref} aria-label="View GogMeet on GitHub (opens in browser)">GitHub</a>
    </div>
  </div>
</body>
</html>`;

  const chrome = platformWindowChrome("about");
  const win = new BrowserWindow({
    width: 320,
    // Compact stack without Close button (Esc / traffic lights dismiss).
    height: 360,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    ...chrome,
    webPreferences: { ...SECURE_WEB_PREFERENCES },
  });

  unbindAboutTheme?.();
  unbindAboutTheme = bindWindowsThemeBackground(win, "about");

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (repoSafe.length > 0 && url === repoSafe && isSafeAboutRepositoryUrl(url)) {
      shell.openExternal(url).catch((err) => {
        console.error("[About] Failed to open repository URL:", err);
      });
    }
    return { action: "deny" };
  });

  // Block in-page navigations; treat the close sentinel as a hide-cache request.
  const onNavigate = (event: { preventDefault: () => void; url: string }): void => {
    event.preventDefault();
    if (event.url === ABOUT_CLOSE_URL) {
      hideAboutWindow(win);
    }
  };
  win.webContents.on("will-navigate", onNavigate);
  win.webContents.on("will-frame-navigate", onNavigate);

  win.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      hideAboutWindow(win);
    }
  });

  // Hide-cache on OS close (traffic lights); real destroy only on quit/tests.
  // destroy() does not emit "close" — __forceDestroy is for close()-based teardown.
  win.on("close", (event) => {
    if (win.__forceDestroy) return;
    event.preventDefault();
    hideAboutWindow(win);
  });

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch((err: unknown) => {
    console.error("[About] Failed to load about window:", err);
  });

  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    presentAboutWindow(win);
  });

  win.on("closed", () => {
    unbindAboutTheme?.();
    unbindAboutTheme = null;
    releaseAboutDock();
    if (aboutWindow === win) {
      aboutWindow = null;
    }
  });

  aboutWindow = win;
}

/**
 * Force-destroy the cached About window (shutdown / tests).
 * destroy() skips the cancelable "close" event; __forceDestroy is belt-and-suspenders
 * if any path calls close() instead.
 */
export function destroyAboutWindow(): void {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.__forceDestroy = true;
    aboutWindow.destroy();
  }
  aboutWindow = null;
  unbindAboutTheme?.();
  unbindAboutTheme = null;
  releaseAboutDock();
}
