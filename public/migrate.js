'use strict';
(() => {
  const settings = JSON.parse(document.getElementById('settings').dataset.value);
  const status = document.getElementById('status');
  const marker = 'tailnow-storage-import-v1';
  if (settings.receiver) {
    window.addEventListener('message', event => {
      if (event.source !== parent || !settings.legacyOrigins.includes(event.origin) || new URL(event.origin).hostname !== location.hostname || event.data?.type !== 'tailnow-storage-copy' || event.data.slug !== settings.slug) return;
      const copied = [];
      try {
        if (!localStorage.getItem(marker) && Array.isArray(event.data.items) && event.data.items.length <= 50) {
          let size = 0;
          for (const item of event.data.items) {
            if (!Array.isArray(item) || item.length !== 2 || !settings.keys.includes(item[0]) || typeof item[1] !== 'string' || (size += item[1].length) > 4 * 1024 * 1024) throw new Error('Invalid migration');
          }
          for (const [key, value] of event.data.items) {
            if (localStorage.getItem(key) === null) { localStorage.setItem(key, value); copied.push(key); }
          }
          localStorage.setItem(marker, '1');
        }
        event.source.postMessage({ type: 'tailnow-storage-done', slug: settings.slug, nonce: event.data.nonce, copied }, event.origin);
      } catch { event.source.postMessage({ type: 'tailnow-storage-failed', nonce: event.data.nonce }, event.origin); }
    });
    return;
  }
  const link = document.getElementById('continue');
  const fail = () => { status.textContent = 'Saved preferences could not be moved automatically. Your original copy is still available in this browser. You can continue and retry this old link later.'; link.hidden = false; };
  if (location.origin !== settings.sourceOrigin) return fail();
  // Cross-site iframe storage may be partitioned or unavailable. Never remove
  // the original copy unless both pages share the same HTTPS hostname.
  if (new URL(settings.targetOrigin).hostname !== location.hostname) return fail();
  const nonce = crypto.randomUUID(), items = [];
  try { for (const key of settings.keys) { const value = localStorage.getItem(key); if (value !== null) items.push([key, value]); } }
  catch { return fail(); }
  const frame = document.createElement('iframe'); frame.hidden = true;
  const deadline = setTimeout(fail, 10000);
  window.addEventListener('message', event => {
    if (event.origin !== settings.targetOrigin || event.source !== frame.contentWindow || event.data?.nonce !== nonce) return;
    clearTimeout(deadline);
    if (event.data.type !== 'tailnow-storage-done' || event.data.slug !== settings.slug) return fail();
    // Never delete a source value that changed or was not copied successfully.
    try { for (const key of event.data.copied || []) if (items.some(([name, value]) => name === key && localStorage.getItem(key) === value)) localStorage.removeItem(key); }
    catch { /* A retained old copy is preferable to lost data. */ }
    location.replace(settings.destination + location.hash);
  });
  frame.onload = () => frame.contentWindow.postMessage({ type: 'tailnow-storage-copy', slug: settings.slug, nonce, items }, settings.targetOrigin);
  frame.src = settings.targetOrigin + '/_tailnow/storage-import'; document.body.append(frame);
})();
