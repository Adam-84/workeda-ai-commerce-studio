# Descriptions de Pull Request

## Phase 10 — `feat/cloud-foundation`

**Titre :** Préparer un serveur Archipel central, ses workers et ses sauvegardes

Serveur Node unique authentifié sur SQLite, courtier de workers `claude.text` sans outils, outils d'aperçu, de sauvegarde et de restauration des bases, déploiement Docker privé et documentation. L'arrêt général persiste au redémarrage, rien d'interrompu n'est rejoué, une mission attend un worker offrant son modèle. Le serveur local écoute toujours uniquement sur la boucle locale.

Vérifications : 558 tests réussis au commit `c68db1c`, 22 Skills et 11 fiches cohérents.

Non vérifié : construction du conteneur, appel IA réel, TLS, déploiement. Limites : voir `docs/CLOUD.md` et `docs/WORKERS.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Phase 11 — `feat/mobile-pwa`

**Titre :** Rendre Archipel utilisable sur mobile (PWA) avec un tableau de bord de direction

Navigation tactile en bas d'écran, tableau de bord, équipe, suivi des missions, réglages d'exploitation et alertes locales ; manifeste, icônes Pixel Art, service worker limité à des fichiers publics, page hors connexion. Corrige aussi le débordement de la barre du haut et la largeur des panneaux sur petit écran.

Vérifications : suite complète réussie (nombre indiqué dans le commit), recette aux largeurs 375, 800 et 1366 px sur données fictives, service worker et repli hors connexion constatés dans le navigateur intégré.

Non vérifié : appareil réel, installation Android ou iOS, affichage des notifications système. Pas de Web Push.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
