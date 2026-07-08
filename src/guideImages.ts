// Runtime image policy for the in-app user guide modal (main.ts helpBtn handler).
//
// The guide's images are not bundled — scripts/build-user-guide.mjs points them
// at the published GitHub Pages site instead, emitted as `data-src` (not `src`)
// so nothing fetches until this module decides to promote them. That decision
// is a reachability probe against a small, permanent probe image — deliberately
// not navigator.onLine, which only reflects the network interface, not whether
// github.io is actually reachable (proxy/auth walls, DNS, actual outage).

// GUIDE_PROBE_URL must never be renamed or removed in a future release — its
// only job is answering "can we reach github.io right now", not "do this
// release's images exist".
const GUIDE_PROBE_URL = 'https://telecasterer.github.io/tsmap/images/probe.png';
export const GUIDE_ONLINE_URL = 'https://telecasterer.github.io/tsmap/user-guide/';

async function probeGuideReachability(timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(GUIDE_PROBE_URL, {
      method: 'HEAD',
      cache: 'no-store',
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs a fresh reachability probe (no caching — connectivity can change
 * between launches, and even within a session) and either promotes each
 * guide image's `data-src` to `src` (wiring a per-image `onerror` fallback
 * first) or removes all images and shows a link to the online guide.
 */
export async function applyGuideImagePolicy(
  root: HTMLElement,
  openExternal: (url: string) => void,
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void,
): Promise<void> {
  const images = Array.from(root.querySelectorAll<HTMLImageElement>('img[data-src]'));
  if (images.length === 0) return;

  const reachable = await probeGuideReachability();

  if (!reachable) {
    onLog('info', 'User guide: could not reach telecasterer.github.io — showing text-only guide.');
    for (const img of images) img.remove();
    const note = document.createElement('div');
    note.className = 'tsmap-guide-offline-note';
    const link = document.createElement('a');
    link.href = GUIDE_ONLINE_URL;
    link.textContent = 'View the full guide with images online';
    link.addEventListener('click', e => {
      e.preventDefault();
      openExternal(GUIDE_ONLINE_URL);
    });
    note.append('Images are unavailable offline. ', link, '.');
    root.querySelector('.tsmap-guide')?.prepend(note);
    return;
  }

  onLog('info', `User guide: loading ${images.length} image${images.length !== 1 ? 's' : ''} from telecasterer.github.io.`);
  for (const img of images) {
    img.onerror = () => {
      img.remove();
      onLog('warn', `User guide: image failed to load — ${img.dataset.src}`);
    };
    img.src = img.dataset.src!;
  }
}
