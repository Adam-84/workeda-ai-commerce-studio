# Phase 11 — Archipel sur mobile (PWA) : conception

Date : 26 novembre 2026. Base : `feat/cloud-foundation`. Cette conception applique les paragraphes 22 à 26 de la demande de finalisation ; le propriétaire autorise les décisions techniques courantes sans validation intermédiaire. Elle reste modifiable avant fusion.

## Choix

Étendre l'interface actuelle, sans bibliothèque ni compilation. Sur grand écran, la carte et la barre du haut restent ; un bouton « Tableau de bord » s'ajoute. Sous 700 px, une barre de navigation en bas remplace les boutons du haut : Accueil, Équipe, Missions, Messages, Plus. La carte Pixel Art reste le bureau des agents, accessible depuis « Plus » et en fermant le panneau.

Écartés : une application mobile séparée (deux interfaces à maintenir) ; un cadriciel (réécriture de l'existant).

## Éléments

| Élément | Fichier | Rôle |
| --- | --- | --- |
| Modèle du tableau de bord | `public/dashboard-view.js` | Fonction pure : réponses de l'API → cartes ; toute donnée absente est « Indisponible » ou « Inconnu » |
| Écrans | `public/hq-ui.js` | Tableau de bord, équipe, missions, menu « Plus », réglages d'exploitation et de notifications |
| Alertes | `public/alerts.js` | Fonction pure : différence entre deux relevés → messages génériques selon les préférences |
| Installation | `public/manifest.webmanifest`, `public/icons/` | Icônes Pixel Art générées par `tools/make-icons.mjs` |
| Hors connexion | `public/sw.js`, `public/offline.html` | Page de repli, mise à jour contrôlée |

## Règles de sécurité

- Le service worker ne met en cache qu'une liste fixe de fichiers publics : page hors ligne, manifeste, icônes. Il ne touche jamais `/api/`, `/auth/` ou `/worker/`, ni aucune requête autre que la navigation et cette liste.
- Hors connexion, aucune action n'est mise en file ni rejouée. L'application ouverte affiche une bannière avec l'heure du dernier relevé.
- En mode central, seuls ces mêmes fichiers publics sont servis sans session.
- Les notifications ne contiennent ni titre de mission, ni nom de produit, ni montant.

## Limites assumées

- Pas de Web Push : les alertes n'arrivent que lorsque l'application est ouverte ou en arrière-plan récent. Un envoi depuis le serveur exige HTTPS public, des clés VAPID et un service tiers : décision ultérieure du propriétaire.
- Pas d'alerte « anomalie » ni « recommandation importante » : aucune source structurée ne les distingue.
- L'installation sur Android et iOS demande HTTPS ; seule la recette sur l'adresse locale est vérifiable ici.

## Vérification

Tests Node pour les deux fonctions pures, le service worker (avec cache simulé), le manifeste, les icônes et les routes publiques ; contrôle visuel dans le navigateur en largeurs mobile et bureau sur données fictives. Aucun appareil physique.
