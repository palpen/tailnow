const { escape } = require('./validation');

function home(entries, state) {
  const button = (slug, action, label, extra = '') => `<button type="button" data-slug="${escape(slug)}" data-action="${action}" ${extra}>${label}</button>`;
  const featured = [], minimized = [], removed = [];
  for (const app of entries.values()) {
    const status = Object.hasOwn(state, app.slug) ? state[app.slug] : undefined;
    if (status?.visibility === 'removed') continue;
    const isMinimized = status?.visibility === 'minimized';
    const controls = button(app.slug, isMinimized ? 'restore' : 'minimize', isMinimized ? 'Restore' : 'Minimize') +
      button(app.slug, 'confirm-remove', 'Remove…', `data-name="${escape(app.name)}" data-shutdown="${app.shutdown?.type || ''}"`);
    const reorder = `<button type="button" class="reorder-handle" aria-label="Reorder ${escape(app.name)}" aria-describedby="reorder-help" title="Drag to reorder; use arrow keys when focused"><span aria-hidden="true">⠿</span></button>`;
    const moves = `<div class="order-controls"><button type="button" data-move="up" aria-label="Move ${escape(app.name)} up">↑</button><button type="button" data-move="down" aria-label="Move ${escape(app.name)} down">↓</button></div>`;
    const card = `<article class="app${isMinimized ? ' compact' : ''}" data-slug="${escape(app.slug)}" data-name="${escape(app.name)}">${reorder}<a draggable="false" href="${escape(app.kind === 'site' ? app.url : `/${app.slug}`)}"><strong>${escape(app.name)}</strong><span>${escape(app.description)}</span></a><div class="controls">${controls}</div>${moves}</article>`;
    (isMinimized ? minimized : featured).push(card);
  }
  for (const [slug, status] of Object.entries(state)) {
    if (status.visibility !== 'removed') continue;
    const app = entries.get(slug);
    const label = { none: 'Removed from this directory only', pending: app?.shutdown ? 'Shutdown needs verification — retry to confirm' : 'Shutdown needs verification on the server', stopped: 'Shut down', failed: app?.shutdown ? 'Shutdown failed — you can retry' : 'Shutdown needs attention on the server' }[status.shutdown];
    const controls = (app && status.shutdown === 'none' ? button(slug, 'restore', 'Restore') : '') +
      (app?.shutdown && status.shutdown !== 'stopped' ? button(slug, 'confirm-stop', 'Shut down…', `data-name="${escape(status.name)}" data-shutdown="${app.shutdown.type}"`) : '');
    removed.push(`<article class="removed-app"><div><strong>${escape(status.name)}</strong><span>${label}</span></div><div class="controls">${controls}</div></article>`);
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TailNow · Your apps</title><link rel="stylesheet" href="/style.css"><script src="/app.js" defer></script></head><body><main><div class="auth-bar"><span id="access-status">View only</span><button id="sign-in" type="button">Administrator sign in</button><button id="sign-out" type="button" hidden>Sign out</button></div><h1>TailNow</h1><p id="notice" role="status" aria-live="polite"></p><section aria-labelledby="featured-title"><div class="list-heading"><h2 id="featured-title">Your apps <span class="count">${featured.length}</span></h2><button type="button" id="toggle-reorder" aria-pressed="false">Reorder</button></div><p id="reorder-help" class="hint">Hold an app to drag on touchscreens. Drag on desktop, or choose Reorder for move buttons. Focus a grip and use ↑ / ↓.</p><p id="reorder-status" class="sr-only" role="status" aria-live="polite"></p><div class="apps">${featured.join('') || '<p class="empty">No apps up front. Restore a minimized app to bring it here.</p>'}</div></section>${minimized.length ? `<details id="minimized"><summary>Minimized <span class="count">${minimized.length}</span><span class="hint">Still available</span></summary><div class="apps minimized">${minimized.join('')}</div></details>` : ''}${removed.length ? `<details id="removed"><summary>Removed <span class="count">${removed.length}</span></summary><div class="removed-list">${removed.join('')}</div><p class="hint">Publish a site again to bring it back. Stopped standalone services need to be restarted on the server.</p></details>` : ''}<footer>Minimizing keeps each app available at its usual address. Your layout is saved across devices.</footer></main><dialog id="remove-dialog" aria-labelledby="dialog-title" aria-describedby="dialog-description"><form method="dialog"><h2 id="dialog-title">Remove app?</h2><p id="dialog-description"></p><label id="shutdown-option"><input type="checkbox" id="shutdown-checkbox"> Also shut down on the server</label><p id="shutdown-help" class="hint"></p><p id="dialog-error" role="alert"></p><div class="dialog-actions"><button id="cancel-remove" type="button">Cancel</button><button id="confirm-remove" type="submit" class="danger">Remove</button></div></form></dialog><dialog id="login-dialog" aria-labelledby="login-title"><form id="login-form"><h2 id="login-title">Administrator sign in</h2><p>Enter the private administrator key from the computer running TailNow.</p><label for="admin-key">Administrator key</label><input id="admin-key" type="password" autocomplete="off" required maxlength="128"><p id="login-error" role="alert"></p><div class="dialog-actions"><button id="cancel-login" type="button">Cancel</button><button id="submit-login" type="submit">Sign in</button></div></form></dialog></body></html>`;
}


module.exports = { home };
