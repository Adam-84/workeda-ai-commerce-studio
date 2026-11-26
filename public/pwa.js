// public/pwa.js — installation, mise à jour contrôlée et signalement des coupures. Aucune donnée n'est lue ni mise en file.
const banner = (id, text, action) => {
  let el = document.getElementById(id);
  if (!text) return el?.remove();
  if (!el) { el = document.createElement('div'); el.id = id; el.className = 'net-banner'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = text;
  if (action) { const b = document.createElement('button'); b.type = 'button'; b.textContent = action.label; b.addEventListener('click', action.run); el.append(' ', b); }
};

let lastSeen = new Date(), down = false;
function link(ok) {
  if (ok) { lastSeen = new Date(); if (!down) return; down = false; banner('net-offline', ''); dispatchEvent(new Event('focus')); return; }
  down = true;
  banner('net-offline', `Hors connexion — données relevées à ${lastSeen.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}, non actualisées.`);
}
addEventListener('offline', () => link(false));
addEventListener('online', () => link(true));
addEventListener('archipel:link', (e) => link(e.detail === true));
// Sans réseau, aucun formulaire n'est envoyé : rien n'attend pour repartir plus tard.
addEventListener('submit', (e) => { if (!navigator.onLine) { e.preventDefault(); e.stopImmediatePropagation(); link(false); } }, true);
if (!navigator.onLine) link(false);

if ('serviceWorker' in navigator) {
  let reloading = false;
  const offer = (worker) => banner('net-update', 'Nouvelle version disponible.', { label: 'Recharger', run: () => { reloading = true; worker.postMessage('update'); } });
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading) location.reload(); });
  navigator.serviceWorker.register('/sw.js').then((registration) => {
    if (registration.waiting && navigator.serviceWorker.controller) offer(registration.waiting);
    registration.addEventListener('updatefound', () => { const next = registration.installing; next?.addEventListener('statechange', () => { if (next.state === 'installed' && navigator.serviceWorker.controller) offer(next); }); });
  }).catch(() => { /* navigation privée ou HTTP distant : l'application reste utilisable sans installation */ });
}
