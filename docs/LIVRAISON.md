# Archipel — rapport de livraison (27 novembre 2026)

Quatre états distincts : **développé** (le code existe), **testé** (tests automatiques ou recette sur données fictives), **déployé** (installé sur un serveur), **opérationnel** (utilisable aujourd'hui avec vos vraies données). Rien n'est déployé : aucun serveur, DNS, compte ni dépense. Le code décrit ici est dans `main` (demandes de fusion 13 à 20) ; la base réelle de l'ordinateur principal a été migrée, chaque fois après sauvegarde. Suite automatique sur `main` (`d023e0a`) : 636 tests réussis le 27/11/2026.

| Domaine | Développé | Testé | Déployé | Opérationnel |
| --- | --- | --- | --- | --- |
| Phases 1 à 6 et 8 (agents, Skills, mémoire, communications, Shopify en lecture, intégrations, applications) | Oui, dans `main` | Suite automatique | Non | En local |
| Phase 7, runner Codex | Reporté (branches `codex-runner`, `pal-hardening`) | Isolation non démontrée | Non | Non, désactivé |
| Choix du moteur par agent ou mission (Claude : opus, sonnet, haiku) | Oui, dans `main` (PR 18) | Tests à runners **simulés** ; Opus et Haiku observés sur des appels réels de discussion ; sélecteurs essayés à 375 et 800 px sur base temporaire | Non | En local ; Sonnet choisi explicitement et mode central non essayés en réel ; Codex désactivé |
| Contrôles visibles : bordures contrastées, information distincte des boutons, moteur IA en haut du profil | Oui, dans `main` (PR 19) | Test de contraste sur les quatre thèmes ; écrans vus à 375 et 1100 px sur base temporaire ; affichage confirmé par le propriétaire | Non | En local ; lecteur d’écran et appareil réel non essayés |
| Quota observé chez Claude, attente après refus, confirmation après dépense supplémentaire | Oui, dans `main` (PR 20) | Événements **simulés** ; un relevé **réel** observé le 27/11/2026 avec Claude Code 2.1.101 (fenêtre de 5 h, autorisé, remise à zéro, sans taux) ; écrans vus à 375 et 1100 px | Non | En local ; taux d’utilisation, refus, dépense supplémentaire et mode central jamais observés en réel |
| Comptes IA : toutes les exécutions, modèle constaté, coût inconnu distinct de zéro | Oui, dans `main` (PR 16) | Tests à runners **simulés** ; appels réels de discussion vérifiés le 27/11/2026 ; activité des communications vue à 375, 800 et 1366 px sur base temporaire | Non | En local ; tâches et mode central non essayés en réel ; jetons de cache non additionnés |
| Phase 9, automatisations | Oui, dans `main` | Suite automatique, recette partielle | Non | En local |
| Phase 10, serveur central, authentification, sauvegardes | Oui | Suite automatique ; contenu d'image simulé et démarré sans Docker | Non | Non |
| Phase 10, workers Claude | Oui | Exécuteurs **simulés** seulement | Non | Non : aucun appel réel ; conditions fournisseur à confirmer |
| Phase 10, conteneur Docker | Configuration écrite | **Jamais construit** (moteur Docker arrêté) | Non | Non |
| Regroupement des bases des deux PC | Aperçu, comparaison, sauvegarde, restauration ; pas de fusion | Bases temporaires | Non | Non, votre accord requis |
| Phase 11, interface mobile et PWA | Oui | Tests Node ; largeurs 375, 800 et 1366 px dans le navigateur intégré | Non | En local ; installation mobile après HTTPS |
| Notifications | Alertes locales quand l'application est ouverte | Fonctions pures ; affichage système non vérifié | Non | Partiel : pas de Web Push |

Non vérifiés : appareil Android ou iOS réel, lecteur d'écran, charge, Caddy, TLS.

## Branches

Les branches des phases 9 à 11 et du moteur IA sont fusionnées dans `main`. Toute nouvelle branche attend votre accord avant fusion. Descriptions des demandes des phases 10 et 11, pour mémoire : [PR-PHASES-10-11.md](PR-PHASES-10-11.md).

## Installation et utilisation quotidienne

**Local.** Après récupération de `main`, lancer `npm ci` si les dépendances ont changé, puis `start.bat` ou `npm start`, et ouvrir `http://localhost:4318`. Au quotidien : « Tableau de bord » pour les validations, l'état et le quota observé ; Comms pour les résultats à vérifier ; Automations pour les calendriers. Les agents ne travaillent que sur demande ou règle activée, et seulement tant que l'ordinateur est allumé. Le moteur IA d'un agent se choisit en haut de son onglet Profil.

**Central.** Suivre [CLOUD.md](CLOUD.md) (installation, configuration, arrêt général, sauvegardes, mise à jour, retour arrière), [HOSTING.md](HOSTING.md) (coûts), [WORKERS.md](WORKERS.md) (moteurs et conditions) et [DATABASE-TRANSFER.md](DATABASE-TRANSFER.md) (bases).

**Mobile.** Une fois le serveur en HTTPS : Android, menu du navigateur « Installer l'application » ; iOS, Partager puis « Sur l'écran d'accueil ». Détails dans [la conception PWA](superpowers/specs/2026-11-26-mobile-pwa-design.md).

Autres guides : [automatisations](AUTOMATION-SYSTEM.md), [communications](COMMUNICATION.md), [mémoire](MEMOIRE.md), [intégrations](INTEGRATIONS.md), [applications Shopify](SHOPIFY-APPS.md). Agents et recrutement : [README](../README.md).

## Dépannage

| Symptôme | Cause probable | Action |
| --- | --- | --- |
| `Cannot find package '@js-temporal/polyfill'` | Dépendance non installée | `npm ci` |
| « Hôte refusé » sur le serveur central | Adresse ouverte différente de `ARCHIPEL_ORIGIN` | Utiliser exactement la même (`127.0.0.1` n'est pas `localhost`) |
| Missions IA qui restent en file | Aucun worker disponible pour le modèle, ou arrêt général | Tableau de bord : serveur et moteurs |
| Worker « bloqué » | Résultat incertain sur son identité | Vérifier que l’ancien processus est arrêté, puis `node tools/workers.mjs release --id … --process-stopped` sur le serveur |
| Automatisations inactives après installation | Exécuteur non désigné ou règle désactivée | Automations : désigner, puis activer chaque règle |
| Connexion refusée plusieurs minutes | Cinq mots de passe erronés | Attendre quinze minutes |

## Retour arrière

Local : sauvegarder le dossier `data/`, revenir au commit précédent, relancer `npm ci` ; les migrations sont additives mais le retour du code n'annule pas un schéma : restaurer la sauvegarde si nécessaire. Central : rétablir ensemble l'ancienne image et ses volumes (voir CLOUD.md).

## Actions qui vous reviennent

1. Relire et autoriser les fusions.
2. Confirmer auprès d'Anthropic l'usage d'un abonnement personnel par un worker, ou approuver un coût d'API.
3. Choisir un hébergeur et autoriser la dépense, le DNS et l'exposition.
4. Autoriser le regroupement des bases des deux PC ou leur transfert vers un serveur, après aperçu.
5. Décider si le dépôt GitHub doit rester public.
