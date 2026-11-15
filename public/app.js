const dialog = document.querySelector('#remove-dialog');
const checkbox = document.querySelector('#shutdown-checkbox');
const confirm = document.querySelector('#confirm-remove');
const cancel = document.querySelector('#cancel-remove');
const notice = document.querySelector('#notice');
let selection;
let saving = false;
let adminToken = '';
let isAdmin = false;
const loginDialog = document.querySelector('#login-dialog');
const authHeaders = () => ({ 'X-Tailnow-Request': '1', Authorization: `Bearer ${adminToken}` });
function setAdmin(token) {
  adminToken = token; isAdmin = Boolean(token);
  document.body.classList.toggle('is-admin', isAdmin);
  document.querySelector('#sign-in').hidden = isAdmin;
  document.querySelector('#sign-out').hidden = !isAdmin;
  document.querySelector('#access-status').textContent = isAdmin ? 'Administrator' : 'View only';
  try { if (token) sessionStorage.setItem('tailnow-admin-session', token); else sessionStorage.removeItem('tailnow-admin-session'); } catch {}
}
document.querySelector('#sign-in').addEventListener('click', () => { loginDialog.showModal(); document.querySelector('#admin-key').focus(); });
document.querySelector('#cancel-login').addEventListener('click', () => loginDialog.close());
document.querySelector('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = document.querySelector('#admin-key'), key = input.value.trim(); input.value = '';
  const button = document.querySelector('#submit-login'); button.disabled = true;
  try {
    const response = await fetch('/api/admin/login', { method: 'POST', headers: { 'X-Tailnow-Request': '1', Authorization: `Bearer ${key}` }, credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error(await response.text());
    setAdmin((await response.json()).token); loginDialog.close();
    document.querySelector('#login-error').textContent = ''; notice.textContent = 'Administrator access enabled for one hour.';
  } catch (error) { document.querySelector('#login-error').textContent = error.message || 'Could not sign in.'; }
  finally { button.disabled = false; }
});
document.querySelector('#sign-out').addEventListener('click', async () => {
  try { await fetch('/api/admin/logout', { method: 'POST', headers: authHeaders(), credentials: 'omit' }); }
  catch { /* Clear this browser's credential even when the server is offline. */ }
  finally { setAdmin(''); notice.textContent = 'Signed out.'; }
});
void (async () => {
  try {
    const token = sessionStorage.getItem('tailnow-admin-session');
    if (!token) return;
    const response = await fetch('/api/admin/session', { headers: { Authorization: `Bearer ${token}` }, credentials: 'omit', cache: 'no-store' });
    setAdmin(response.ok ? token : '');
  } catch { setAdmin(''); }
})();

try {
  notice.textContent = sessionStorage.getItem('mini-notice') || '';
  sessionStorage.removeItem('mini-notice');
  for (const id of JSON.parse(sessionStorage.getItem('mini-open') || '[]')) {
    if (['minimized', 'removed'].includes(id)) document.getElementById(id)?.setAttribute('open', '');
  }
} catch { /* The controls also work with browser storage disabled. */ }

async function change(slug, action) {
  if (saving || !isAdmin) return;
  saving = true;
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  checkbox.disabled = true;
  notice.textContent = action === 'shutdown' ? 'Removing and shutting down…' : 'Saving…';
  confirm.textContent = action === 'shutdown' ? 'Shutting down…' : 'Saving…';
  let message;
  try {
    const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/${action}`, {
      method: 'POST', headers: authHeaders(), credentials: 'omit',
    });
    if (response.status === 401) setAdmin('');
    message = response.ok ? {
      minimize: 'App minimized. It is still available at its usual address.',
      restore: 'App restored to your directory.',
      remove: 'App removed from the directory. Its server was left running.',
      shutdown: 'App removed and shut down. Its files have been kept.',
    }[action] : await response.text();
  } catch {
    message = 'The connection was interrupted. Check the directory before retrying.';
  }
  try {
    sessionStorage.setItem('mini-notice', message);
    const open = [...document.querySelectorAll('details[open]')].map(element => element.id);
    if (action === 'shutdown' || action === 'remove') open.push('removed');
    sessionStorage.setItem('mini-open', JSON.stringify(open));
  } catch {
    dialog.close();
    notice.textContent = message;
    const reload = document.createElement('a');
    reload.href = '/';
    reload.textContent = ' Refresh directory';
    notice.append(reload);
    return;
  }
  window.location.reload();
}

document.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button || saving || !isAdmin) return;
  const { slug, action, name, shutdown } = button.dataset;
  if (action === 'minimize' || action === 'restore') {
    void change(slug, action);
    return;
  }
  selection = { slug, stopOnly: action === 'confirm-stop' };
  document.querySelector('#dialog-title').textContent = `${selection.stopOnly ? 'Shut down' : 'Remove'} ${name}?`;
  document.querySelector('#dialog-description').textContent = selection.stopOnly
    ? 'This app is already removed from your directory. Shut it down on the server too?'
    : 'This removes the shortcut from your directory on all devices. You can also shut down the app below.';
  document.querySelector('#shutdown-option').hidden = !shutdown || selection.stopOnly;
  checkbox.checked = selection.stopOnly;
  checkbox.disabled = !shutdown;
  document.querySelector('#shutdown-help').textContent = shutdown === 'tailnow'
    ? 'Shutting down unpublishes this site and keeps its files for recovery. Other TailNow sites keep running. Publish it again to bring it back.'
    : shutdown === 'launchAgent'
      ? 'Shutting down stops this service and disables automatic restarts. Its files are kept. Starting it again requires access to the server.'
      : 'Shutdown is not configured for this app. Removing its shortcut leaves the app running.';
  confirm.textContent = selection.stopOnly ? 'Shut down' : 'Remove';
  dialog.showModal();
  cancel.focus();
});

checkbox.addEventListener('change', () => {
  confirm.textContent = checkbox.checked ? 'Remove & shut down' : 'Remove';
});
cancel.addEventListener('click', () => dialog.close());
dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
dialog.querySelector('form').addEventListener('submit', event => {
  event.preventDefault();
  if (selection) void change(selection.slug, selection.stopOnly || checkbox.checked ? 'shutdown' : 'remove');
});

// Keep native touch scrolling until a stationary long press claims the gesture.
const reorderStatus = document.querySelector('#reorder-status');
const reorderToggle = document.querySelector('#toggle-reorder');
let gesture;
let blockedClickUntil = 0;
const cards = list => [...list.querySelectorAll(':scope > .app')];
const announce = message => { reorderStatus.textContent = message; };

function updateMoveButtons() {
  for (const list of document.querySelectorAll('.apps')) {
    const rows = cards(list);
    rows.forEach((row, index) => {
      row.querySelector('[data-move="up"]').disabled = saving || index === 0;
      row.querySelector('[data-move="down"]').disabled = saving || index === rows.length - 1;
    });
  }
}
function restoreRows(list, rows) { for (const row of rows) list.append(row); }
function showReorder() {
  if (!isAdmin) return;
  const open = !document.body.classList.contains('reordering');
  document.body.classList.toggle('reordering', open);
  reorderToggle.setAttribute('aria-pressed', String(open));
  reorderToggle.textContent = open ? 'Done' : 'Reorder';
}
reorderToggle.addEventListener('click', showReorder);

async function savePosition(row, original, focused = document.activeElement) {
  if (!isAdmin) return;
  const list = row.parentElement;
  const rows = cards(list);
  if (rows.every((item, index) => item === original[index])) return;
  saving = true;
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  announce(`Saving ${row.dataset.name}…`);
  const before = row.nextElementSibling?.dataset.slug;
  const target = before ? `before/${encodeURIComponent(before)}` : 'last';
  try {
    const response = await fetch(`/api/apps/${encodeURIComponent(row.dataset.slug)}/${target}`, {
      method: 'POST', headers: authHeaders(), credentials: 'omit',
    });
    if (response.status === 401) setAdmin('');
    if (!response.ok) throw new Error(await response.text());
    announce(`${row.dataset.name} moved to position ${rows.indexOf(row) + 1} of ${rows.length}. Order saved across devices.`);
    notice.textContent = '';
  } catch {
    restoreRows(list, original);
    notice.textContent = 'Could not confirm the new order. Reload the directory to check the saved order before retrying.';
    announce(notice.textContent);
  } finally {
    saving = false;
    for (const button of document.querySelectorAll('button')) button.disabled = false;
    updateMoveButtons();
    if (focused?.matches('button') && !focused.disabled) focused.focus({ preventScroll: true });
  }
}
function moveOne(row, direction) {
  if (saving || gesture || !isAdmin) return;
  const focused = document.activeElement;
  const original = cards(row.parentElement);
  const sibling = direction === 'up' ? row.previousElementSibling : row.nextElementSibling;
  if (!sibling) { announce(`${row.dataset.name} is already ${direction === 'up' ? 'first' : 'last'}.`); return; }
  row.parentElement.insertBefore(direction === 'up' ? row : sibling, direction === 'up' ? sibling : row);
  void savePosition(row, original, focused);
}
document.addEventListener('click', event => {
  const move = event.target.closest('[data-move]');
  if (move) moveOne(move.closest('.app'), move.dataset.move);
  else if (event.target.closest('.reorder-handle') && !saving) showReorder();
});
document.addEventListener('keydown', event => {
  const handle = event.target.closest('.reorder-handle');
  if (handle && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault();
    moveOne(handle.closest('.app'), event.key === 'ArrowUp' ? 'up' : 'down');
  }
  if (event.key === 'Escape' && gesture) { event.preventDefault(); finishDrag(false); }
});
document.addEventListener('click', event => {
  if (gesture?.active || (performance.now() < blockedClickUntil && event.target.closest('.app'))) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);
document.addEventListener('dragstart', event => { if (event.target.closest('.app')) event.preventDefault(); });
document.addEventListener('contextmenu', event => { if (gesture && event.target.closest('.app')) event.preventDefault(); });

function candidate(target, x, y, kind, id) {
  const row = target.closest('.app');
  if (saving || gesture || !isAdmin || !row || target.closest('.controls,.order-controls') || (target.closest('button') && !target.closest('.reorder-handle'))) return;
  gesture = { row, list: row.parentElement, original: cards(row.parentElement), x, y, startX: x, startY: y, kind, id, active: false };
  if (kind === 'touch') gesture.timer = setTimeout(beginDrag, 420);
}
function beginDrag() {
  if (!gesture || saving) return;
  const g = gesture;
  clearTimeout(g.timer);
  const rect = g.row.getBoundingClientRect();
  g.offsetY = g.startY - rect.top;
  g.ghost = g.row.cloneNode(true);
  g.ghost.classList.add('drag-preview');
  g.ghost.setAttribute('aria-hidden', 'true');
  g.ghost.inert = true;
  Object.assign(g.ghost.style, { left: `${rect.left}px`, width: `${rect.width}px`, top: `${g.y - g.offsetY}px` });
  document.body.append(g.ghost);
  g.row.classList.add('dragging');
  document.body.classList.add('is-dragging');
  g.active = true;
  if (g.kind !== 'touch') document.body.setPointerCapture(g.id);
  announce(`Moving ${g.row.dataset.name}. Drag up or down. Release to save; Escape to cancel.`);
  g.frame = requestAnimationFrame(dragFrame);
}
function positionRow() {
  const g = gesture;
  if (!g?.active) return;
  g.ghost.style.top = `${g.y - g.offsetY}px`;
  const others = cards(g.list).filter(row => row !== g.row);
  const before = others.find(row => { const rect = row.getBoundingClientRect(); return g.y < rect.top + rect.height / 2; });
  if (g.row.nextElementSibling !== (before || null)) g.list.insertBefore(g.row, before || null);
}
function dragFrame() {
  const g = gesture;
  if (!g?.active) return;
  const edge = Math.min(64, window.innerHeight / 5);
  const speed = g.y < edge ? -Math.min(18, (edge - g.y) / 3) : g.y > window.innerHeight - edge ? Math.min(18, (g.y - window.innerHeight + edge) / 3) : 0;
  if (speed) window.scrollBy(0, speed);
  positionRow();
  g.frame = requestAnimationFrame(dragFrame);
}
function moveGesture(x, y, event) {
  const g = gesture;
  if (!g) return;
  g.x = x; g.y = y;
  if (!g.active && Math.hypot(x - g.startX, y - g.startY) > 10) {
    if (g.kind === 'touch') { finishDrag(false); return; }
    beginDrag();
  }
  if (g.active) { if (event.cancelable) event.preventDefault(); positionRow(); }
}
function finishDrag(commit) {
  const g = gesture;
  if (!g) return;
  gesture = undefined;
  clearTimeout(g.timer);
  cancelAnimationFrame(g.frame);
  if (!g.active) return;
  blockedClickUntil = performance.now() + 500;
  g.ghost.remove();
  g.row.classList.remove('dragging');
  document.body.classList.remove('is-dragging');
  if (g.kind !== 'touch' && document.body.hasPointerCapture(g.id)) document.body.releasePointerCapture(g.id);
  if (commit) void savePosition(g.row, g.original);
  else { restoreRows(g.list, g.original); announce('Reorder cancelled. Order unchanged.'); }
  updateMoveButtons();
}
document.addEventListener('pointerdown', event => {
  if (event.pointerType !== 'touch' && event.isPrimary && event.button === 0) candidate(event.target, event.clientX, event.clientY, event.pointerType, event.pointerId);
});
document.addEventListener('pointermove', event => {
  if (gesture && gesture.kind !== 'touch' && gesture.id === event.pointerId) moveGesture(event.clientX, event.clientY, event);
}, { passive: false });
document.addEventListener('pointerup', event => { if (gesture?.kind !== 'touch' && gesture?.id === event.pointerId) finishDrag(true); });
document.addEventListener('pointercancel', event => { if (gesture?.kind !== 'touch' && gesture?.id === event.pointerId) finishDrag(false); });
document.addEventListener('lostpointercapture', event => { if (gesture?.kind !== 'touch' && gesture?.id === event.pointerId) finishDrag(false); });
document.addEventListener('touchstart', event => {
  if (event.touches.length !== 1) { finishDrag(false); return; }
  const touch = event.touches[0];
  candidate(event.target, touch.clientX, touch.clientY, 'touch', touch.identifier);
}, { passive: true });
document.addEventListener('touchmove', event => {
  if (gesture?.kind !== 'touch') return;
  const touch = [...event.touches].find(item => item.identifier === gesture.id);
  if (touch) moveGesture(touch.clientX, touch.clientY, event);
}, { passive: false });
document.addEventListener('touchend', event => {
  if (gesture?.kind === 'touch' && [...event.changedTouches].some(item => item.identifier === gesture.id)) finishDrag(true);
});
document.addEventListener('touchcancel', () => finishDrag(false));
window.addEventListener('blur', () => finishDrag(false));
document.addEventListener('visibilitychange', () => { if (document.hidden) finishDrag(false); });
window.addEventListener('scroll', () => { if (gesture && !gesture.active) finishDrag(false); }, { passive: true });
updateMoveButtons();
