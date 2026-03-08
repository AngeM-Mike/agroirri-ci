/**
 * AgroIrri CI — sw.js (Service Worker)
 * 
 * Ce fichier tourne en arrière-plan sur le téléphone.
 * Il permet à l'app de fonctionner sans internet.
 * 
 * Fonctionnement :
 *  1. "install"  → sauvegarde tous les fichiers de l'app dans un cache
 *  2. "activate" → supprime les anciens caches
 *  3. "fetch"    → intercepte les requêtes réseau :
 *                  - Si internet disponible → requête normale
 *                  - Si hors-ligne         → utilise le cache sauvegardé
 */

// Nom et version du cache (change ce nom pour forcer une mise à jour)
const NOM_CACHE    = 'agroirri-ci-v1';
const FICHIERS_APP = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon.svg',
  'https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&family=Playfair+Display:wght@700&display=swap',
];

// ── Installation : sauvegarde les fichiers ──
self.addEventListener('install', event => {
  console.log('[SW] Installation...');
  
  event.waitUntil(
    caches.open(NOM_CACHE)
      .then(cache => {
        console.log('[SW] Mise en cache des fichiers de l\'app');
        return cache.addAll(FICHIERS_APP);
      })
      .then(() => self.skipWaiting()) // Active tout de suite sans attendre
  );
});

// ── Activation : nettoie les anciens caches ──
self.addEventListener('activate', event => {
  console.log('[SW] Activation...');

  event.waitUntil(
    caches.keys().then(nomsCache => {
      return Promise.all(
        nomsCache
          .filter(nom => nom !== NOM_CACHE) // Tous les caches sauf le nouveau
          .map(nom => {
            console.log('[SW] Suppression de l\'ancien cache :', nom);
            return caches.delete(nom);
          })
      );
    }).then(() => self.clients.claim()) // Prend le contrôle immédiatement
  );
});

// ── Fetch : répond aux requêtes réseau ──
self.addEventListener('fetch', event => {
  const url = event.request.url;
  
  // Pour l'API Open-Meteo : on essaie le réseau en premier
  // Si hors-ligne, on n'a pas de cache pour la météo → erreur gérée dans app.js
  if (url.includes('open-meteo.com')) {
    event.respondWith(
      fetch(event.request)
        .catch(() => {
          // Pas d'internet → app.js affichera la dernière analyse sauvegardée
          return new Response(
            JSON.stringify({ error: 'hors-ligne' }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        })
    );
    return;
  }

  // Pour les fichiers de l'app : Cache d'abord, puis réseau
  event.respondWith(
    caches.match(event.request)
      .then(reponseCache => {
        if (reponseCache) {
          // Fichier trouvé dans le cache → on le retourne
          return reponseCache;
        }
        // Pas dans le cache → on essaie le réseau
        return fetch(event.request)
          .then(reponseReseau => {
            // On sauvegarde la nouvelle ressource dans le cache
            if (reponseReseau && reponseReseau.status === 200) {
              const copieReponse = reponseReseau.clone();
              caches.open(NOM_CACHE).then(cache => {
                cache.put(event.request, copieReponse);
              });
            }
            return reponseReseau;
          });
      })
  );
});
