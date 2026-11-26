# Archipel — rapport de livraison (26 novembre 2026)

Quatre états distincts : **développé** (le code existe), **testé** (tests automatiques ou recette sur données fictives), **déployé** (installé sur un serveur), **opérationnel** (utilisable aujourd'hui avec vos vraies données). Rien n'est déployé : aucun serveur, DNS, compte ou dépense, aucune donnée réelle migrée, aucune fusion dans `main`.

| Domaine | Développé | Testé | Déployé | Opérationnel |
| --- | --- | --- | --- | --- |
| Phases 1 à 6 et 8 (agents, Skills, mémoire, communications, Shopify en lecture, intégrations, applications) | Oui, dans `main` | Suite automatique | Non | En local |
| Phase 7, runner Codex | Reporté (branches `codex-runner`, `pal-hardening`) | Isolation non démontrée | Non | Non, désactivé |
| Choix du moteur par agent ou mission, quotas et coûts séparés par fournisseur | **Non** | Non | Non | Non ; Claude seul, modèle fixé par la fiche de l'agent |
| Phase 9, automatisations | Oui | Suite automatique, recette partielle | Non | En local après fusion de la PR 13 |
| Phase 10, serveur central, authentification, sauvegardes | Oui | Suite automatique ; contenu d'image simulé et démarré sans Docker | Non | Non |
| Phase 10, workers Claude | Oui | Exécuteurs **simulés** seulement | Non | Non : aucun appel réel ; conditions fournisseur à confirmer |
| Phase 10, conteneur Docker | Configuration écrite | **Jamais construit** (moteur Docker arrêté) | Non | Non |
| Migration des bases des deux PC | Aperçu, comparaison, sauvegarde, restauration ; pas de fusion | Bases temporaires | Non | Non, votre accord requis |
| Phase 11, interface mobile et PWA | Oui | Tests Node ; largeurs 375, 800 et 1366 px dans le navigateur intégré | Non | En local ; installation mobile après HTTPS |
| Notifications | Alertes locales quand l'application est ouverte | Fonctions pures ; affichage système non vérifié | Non | Partiel : pas de Web Push |

Non vérifiés : appareil Android ou iOS réel, lecteur d'écran, charge, Caddy, TLS.

## Branches et ordre de fusion

Chaque branche contient la précédente. Relire et fusionner dans cet ordre, après votre accord :

1. `feat/automation-system` → `main` ([PR 13](https://github.com/Adam-84/workeda-ai-commerce-studio/pull/13), brouillon) ;
2. `feat/cloud-foundation` → `main` ([ouvrir la PR](https://github.com/Adam-84/workeda-ai-commerce-studio/compare/feat/automation-system...feat/cloud-foundation?expand=1), base `feat/automation-system` tant que la PR 13 n'est pas fusionnée) ;
3. `feat/mobile-pwa` → `main` ([ouvrir la PR](https://github.com/Adam-84/workeda-ai-commerce-studio/compare/feat/cloud-foundation...feat/mobile-pwa?expand=1), base `feat/cloud-foundation`).

Descriptions prêtes à coller : [PR-PHASES-10-11.md](PR-PHASES-10-11.md).

## Installation et utilisation quotidienne

**Local.** Après récupération de ces branches, lancer une fois `npm ci` (la Phase 9 ajoute une dépendance), puis `start.bat` ou `npm start`, et ouvrir `http://localhost:4318`. Au quotidien : « Tableau de bord » pour les validations et l'état ; Comms pour les résultats à vérifier ; Automations pour les calendriers. Les agents ne travaillent que sur demande ou règle activée, et seulement tant que l'ordinateur est allumé.

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
4. Autoriser la migration des données réelles, après aperçu.
5. Décider si le dépôt GitHub doit rester public.
