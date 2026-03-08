/**
 * AgroIrri CI — app.js
 * Cerveau de l'application
 *
 * Ce fichier gère :
 *  1. La navigation entre les 3 écrans
 *  2. L'appel à l'API Open-Meteo (météo Yamoussoukro)
 *  3. Le calcul ET₀ selon la formule FAO-56
 *  4. La décision d'irrigation (OUI / NON) + volume en litres
 *  5. La sauvegarde en localStorage (mode hors-ligne)
 *  6. Les notifications programmées à 6h00
 */

// ══════════════════════════════════════════
//  CONSTANTES DU PROJET
// ══════════════════════════════════════════

// Coordonnées GPS de Yamoussoukro, Côte d'Ivoire
const LATITUDE  = 6.8276;
const LONGITUDE = -5.2893;

// Paramètres de la culture de M. Koffi
const SURFACE_M2 = 200;        // Surface en m²
const KC_TOMATE  = 1.15;       // Coefficient cultural tomate (stade développement)
const SEUIL_PLUIE_MM = 5;      // Si pluie > 5mm prévue → pas besoin d'irriguer
const EFFICIENCE_IRRIGATION = 0.85; // Efficience du système d'arrosage

// Noms des jours pour les prévisions
const JOURS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];

// ══════════════════════════════════════════
//  NAVIGATION ENTRE LES ÉCRANS
// ══════════════════════════════════════════

/**
 * Affiche un écran en masquant tous les autres.
 * @param {string} id - L'id de l'écran à afficher
 */
function afficherEcran(id) {
  // On masque tous les écrans
  document.querySelectorAll('.ecran').forEach(e => e.classList.remove('actif'));
  // On affiche uniquement celui demandé
  document.getElementById(id).classList.add('actif');
}

function retourAccueil() {
  afficherEcran('ecran-accueil');
}

function cacherErreur() {
  document.getElementById('message-erreur').classList.add('cache');
}

// ══════════════════════════════════════════
//  FONCTION PRINCIPALE : DÉMARRER L'ANALYSE
// ══════════════════════════════════════════

/**
 * Lancée quand l'utilisateur appuie sur "Analyser mon champ"
 */
async function demarrerAnalyse() {
  // 1. Passer à l'écran de chargement
  afficherEcran('ecran-chargement');
  reinitialiserEtapes();

  try {
    // 2. Étape 1 : Récupérer la météo
    activerEtape('etape-1');
    const meteo = await recupererMeteo();
    terminerEtape('etape-1');

    // Petite pause visuelle entre les étapes
    await pause(600);

    // 3. Étape 2 : Calculer ET₀
    activerEtape('etape-2');
    const et0 = calculerET0(meteo);
    await pause(800);
    terminerEtape('etape-2');

    await pause(600);

    // 4. Étape 3 : Prendre la décision
    activerEtape('etape-3');
    const resultat = calculerDecision(meteo, et0);
    await pause(700);
    terminerEtape('etape-3');

    await pause(500);

    // 5. Sauvegarder pour le mode hors-ligne
    sauvegarderResultat(resultat);

    // 6. Afficher les résultats
    afficherResultats(resultat);
    afficherEcran('ecran-resultat');

    // 7. Programmer la notification du lendemain à 6h00
    programmerNotification6h();

  } catch (erreur) {
    console.warn('Erreur de connexion :', erreur.message);

    // Pas d'internet : on essaie d'afficher la dernière analyse sauvegardée
    const ancienResultat = chargerResultatSauvegarde();

    if (ancienResultat) {
      afficherResultats(ancienResultat);
      afficherEcran('ecran-resultat');
    } else {
      // Aucune donnée sauvegardée : message d'erreur
      afficherEcran('ecran-accueil');
      document.getElementById('message-erreur').classList.remove('cache');
    }
  }
}

// ══════════════════════════════════════════
//  ÉTAPE 1 : APPEL À L'API OPEN-METEO
// ══════════════════════════════════════════

/**
 * Récupère la météo actuelle et les prévisions depuis Open-Meteo.
 * API gratuite, pas de clé nécessaire.
 * @returns {Object} Données météo structurées
 */
async function recupererMeteo() {
  const url = `https://api.open-meteo.com/v1/forecast?` +
    `latitude=${LATITUDE}&longitude=${LONGITUDE}` +
    `&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,shortwave_radiation` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,shortwave_radiation_sum,wind_speed_10m_max,et0_fao_evapotranspiration` +
    `&timezone=Africa%2FAbidjan` +
    `&forecast_days=4`;

  const reponse = await fetch(url);

  if (!reponse.ok) {
    throw new Error(`Erreur API météo : ${reponse.status}`);
  }

  const donnees = await reponse.json();

  // On extrait ce dont on a besoin
  const actuel = donnees.current;
  const journalier = donnees.daily;

  return {
    // Données du jour
    temperature:  actuel.temperature_2m,
    humidite:     actuel.relative_humidity_2m,
    pluieActuelle: actuel.precipitation,
    vent:         actuel.wind_speed_10m,
    rayonnement:  actuel.shortwave_radiation,

    // Prévision de pluie pour aujourd'hui
    pluiePrevue:  journalier.precipitation_sum[0],

    // ET₀ calculé par Open-Meteo (pour vérification)
    et0OpenMeteo: journalier.et0_fao_evapotranspiration[0],

    // Données pour les 3 prochains jours (indices 1, 2, 3)
    previsions: [1, 2, 3].map(i => ({
      jourIndex:  new Date(journalier.time[i]).getDay(),
      tempMax:    journalier.temperature_2m_max[i],
      tempMin:    journalier.temperature_2m_min[i],
      pluie:      journalier.precipitation_sum[i],
    })),

    // Température min/max du jour
    tempMax: journalier.temperature_2m_max[0],
    tempMin: journalier.temperature_2m_min[0],
  };
}

// ══════════════════════════════════════════
//  ÉTAPE 2 : CALCUL ET₀ (FORMULE FAO-56)
// ══════════════════════════════════════════

/**
 * Calcule l'évapotranspiration de référence ET₀
 * selon la formule simplifiée de Hargreaves (FAO-56)
 * Adaptée pour fonctionner avec les données disponibles.
 *
 * Formule : ET₀ = 0.0023 × (Tmoy + 17.8) × (Tmax - Tmin)^0.5 × Ra
 * Ra = rayonnement extraterrestre (estimé d'après latitude + jour de l'année)
 *
 * @param {Object} meteo - Données météo
 * @returns {number} ET₀ en mm/jour
 */
function calculerET0(meteo) {
  const Tmoy = (meteo.tempMax + meteo.tempMin) / 2;
  const deltaT = Math.abs(meteo.tempMax - meteo.tempMin);

  // Rayonnement extraterrestre Ra (MJ/m²/jour) estimé pour Yamoussoukro
  // Latitude ~6.8°N → Ra varie peu, moyenne annuelle ≈ 36 MJ/m²/jour
  const jourAnnee = obtenirJourAnnee();
  const Ra = calculerRa(LATITUDE, jourAnnee);

  // Formule de Hargreaves
  let et0 = 0.0023 * (Tmoy + 17.8) * Math.pow(deltaT, 0.5) * Ra;

  // On garde 2 décimales, minimum 0
  et0 = Math.max(0, Math.round(et0 * 100) / 100);

  // Si Open-Meteo fournit sa propre valeur ET₀, on fait une moyenne (plus précis)
  if (meteo.et0OpenMeteo && meteo.et0OpenMeteo > 0) {
    et0 = Math.round(((et0 + meteo.et0OpenMeteo) / 2) * 100) / 100;
  }

  return et0;
}

/**
 * Calcule le rayonnement extraterrestre Ra pour une latitude et un jour donnés.
 * @param {number} lat - Latitude en degrés
 * @param {number} jourAnnee - Jour de l'année (1-365)
 * @returns {number} Ra en MJ/m²/jour
 */
function calculerRa(lat, jourAnnee) {
  const Gsc = 0.0820; // Constante solaire (MJ/m²/min)
  const dr   = 1 + 0.033 * Math.cos(2 * Math.PI * jourAnnee / 365);
  const delta = 0.409 * Math.sin(2 * Math.PI * jourAnnee / 365 - 1.39);
  const phi   = lat * Math.PI / 180; // Latitude en radians
  const omega = Math.acos(-Math.tan(phi) * Math.tan(delta)); // Angle horaire

  const Ra = (24 * 60 / Math.PI) * Gsc * dr *
    (omega * Math.sin(phi) * Math.sin(delta) +
     Math.cos(phi) * Math.cos(delta) * Math.sin(omega));

  return Ra;
}

/**
 * Retourne le numéro du jour dans l'année (1 à 365)
 */
function obtenirJourAnnee() {
  const maintenant = new Date();
  const debutAnnee = new Date(maintenant.getFullYear(), 0, 0);
  const diff = maintenant - debutAnnee;
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

// ══════════════════════════════════════════
//  ÉTAPE 3 : DÉCISION D'IRRIGATION
// ══════════════════════════════════════════

/**
 * Décide si M. Koffi doit irriguer aujourd'hui et calcule le volume.
 *
 * Logique :
 *  - Si pluie prévue > seuil (5mm) → PAS D'IRRIGATION
 *  - Sinon : Volume = (ET₀ - pluie) × Surface × Kc / Efficience
 *
 * @param {Object} meteo - Données météo
 * @param {number} et0   - Évapotranspiration calculée
 * @returns {Object} Résultat complet
 */
function calculerDecision(meteo, et0) {
  const pluie = meteo.pluiePrevue || 0;

  // Besoin en eau net
  const besoinNet = Math.max(0, et0 - pluie);

  // Volume à apporter (en litres)
  // 1mm d'eau sur 1m² = 1 litre
  let volumeLitres = (besoinNet * SURFACE_M2 * KC_TOMATE) / EFFICIENCE_IRRIGATION;
  volumeLitres = Math.round(volumeLitres);

  // Décision
  const doitIrriguer = pluie < SEUIL_PLUIE_MM && volumeLitres > 10;

  // Estimation de l'humidité du sol (simplifiée)
  // Base 40%, modulée par pluie et ET₀
  const humiditeSol = Math.min(95, Math.max(20, 
    50 + (pluie * 3) - (et0 * 2)
  ));

  return {
    doitIrriguer,
    volumeLitres:     doitIrriguer ? volumeLitres : 0,
    humidite:         Math.round(humiditeSol),
    pluie:            Math.round(pluie * 10) / 10,
    temperature:      Math.round(meteo.temperature * 10) / 10,
    et0:              et0,
    previsions:       meteo.previsions,
    dateAnalyse:      new Date().toLocaleString('fr-CI', {
      weekday: 'long',
      day:     'numeric',
      month:   'long',
      hour:    '2-digit',
      minute:  '2-digit'
    }),
  };
}

// ══════════════════════════════════════════
//  AFFICHAGE DES RÉSULTATS
// ══════════════════════════════════════════

function afficherResultats(r) {
  // Décision principale
  const icone = r.doitIrriguer ? '💧' : '☀️';
  const texte = r.doitIrriguer ? 'OUI, irriguer' : 'NON, ne pas irriguer';
  const volume = r.doitIrriguer
    ? `Volume : ${r.volumeLitres} litres`
    : 'Pas d\'arrosage nécessaire';

  document.getElementById('decision-icone').textContent  = icone;
  document.getElementById('decision-texte').textContent  = texte;
  document.getElementById('decision-volume').textContent = volume;

  // Couleur de la carte selon la décision
  const carte = document.getElementById('carte-decision');
  carte.style.borderColor = r.doitIrriguer
    ? 'rgba(100, 200, 255, 0.3)'  // Bleu eau
    : 'rgba(255, 220, 50, 0.3)';  // Jaune soleil

  // Données météo
  document.getElementById('val-humidite').textContent = `${r.humidite}%`;
  document.getElementById('val-pluie').textContent    = `${r.pluie} mm`;
  document.getElementById('val-temp').textContent     = `${r.temperature}°C`;
  document.getElementById('val-et0').textContent      = `${r.et0} mm`;

  // Prévisions 3 jours
  const grillePrevi = document.getElementById('previsions-grille');
  grillePrevi.innerHTML = '';

  r.previsions.forEach(jour => {
    const iconeJour = jour.pluie > 5 ? '🌧️' : (jour.pluie > 1 ? '⛅' : '☀️');
    const div = document.createElement('div');
    div.className = 'prevision-jour';
    div.innerHTML = `
      <span class="prev-nom">${JOURS[jour.jourIndex]}</span>
      <span class="prev-icone">${iconeJour}</span>
      <span class="prev-temp">${Math.round(jour.tempMax)}°/${Math.round(jour.tempMin)}°</span>
      <span class="prev-pluie">${jour.pluie > 0 ? jour.pluie.toFixed(1) + ' mm' : 'Sec'}</span>
    `;
    grillePrevi.appendChild(div);
  });

  // Date de l'analyse
  document.getElementById('analyse-date').textContent =
    `Analyse du ${r.dateAnalyse}`;
}

// ══════════════════════════════════════════
//  SAUVEGARDE HORS-LIGNE (localStorage)
// ══════════════════════════════════════════

function sauvegarderResultat(resultat) {
  try {
    localStorage.setItem('agroirri_derniere_analyse', JSON.stringify(resultat));
  } catch (e) {
    console.warn('Impossible de sauvegarder :', e);
  }
}

function chargerResultatSauvegarde() {
  try {
    const sauvegarde = localStorage.getItem('agroirri_derniere_analyse');
    return sauvegarde ? JSON.parse(sauvegarde) : null;
  } catch (e) {
    return null;
  }
}

// ══════════════════════════════════════════
//  NOTIFICATIONS À 6H00
// ══════════════════════════════════════════

/**
 * Programme une notification locale pour demain à 6h00.
 * Demande d'abord la permission à l'utilisateur.
 */
async function programmerNotification6h() {
  // Vérification : les notifications sont-elles supportées ?
  if (!('Notification' in window)) return;

  // Demande de permission
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return;

  // Calcule le délai jusqu'à demain 6h00
  const maintenant    = new Date();
  const demain6h      = new Date(maintenant);
  demain6h.setDate(demain6h.getDate() + 1);
  demain6h.setHours(6, 0, 0, 0);

  const delaiMs = demain6h - maintenant;

  // Programme la notification
  setTimeout(() => {
    new Notification('🌱 AgroIrri CI — Analyse du matin', {
      body:  'Ouvrez l\'app pour connaître le besoin en eau de vos tomates aujourd\'hui.',
      icon:  'icons/icon.svg',
      badge: 'icons/icon.svg',
    });
  }, delaiMs);

  console.log(`Notification programmée dans ${Math.round(delaiMs / 3600000)}h`);
}

// ══════════════════════════════════════════
//  GESTION DES ÉTAPES DE CHARGEMENT
// ══════════════════════════════════════════

function reinitialiserEtapes() {
  ['etape-1', 'etape-2', 'etape-3'].forEach(id => {
    const el = document.getElementById(id);
    el.classList.remove('active', 'finie');
  });
}

function activerEtape(id) {
  document.getElementById(id).classList.add('active');
}

function terminerEtape(id) {
  const el = document.getElementById(id);
  el.classList.remove('active');
  el.classList.add('finie');
}

// ══════════════════════════════════════════
//  UTILITAIRES
// ══════════════════════════════════════════

/**
 * Attend un délai en millisecondes (pour les animations)
 */
function pause(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ══════════════════════════════════════════
//  DÉMARRAGE : ENREGISTREMENT DU SERVICE WORKER
// ══════════════════════════════════════════

/**
 * Au chargement de la page, on enregistre le Service Worker
 * qui gère le mode hors-ligne.
 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('sw.js')
      .then(() => console.log('✅ Service Worker enregistré'))
      .catch(err => console.warn('⚠️ Service Worker :', err));
  });
}
