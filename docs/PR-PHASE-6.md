# Phase 6 — Integration Center : DSers Basic, Shopify Admin préparé, 17TRACK et import CSV (lecture seule)

Branche `integration-center` vers `main`. 5 commits de la phase 6 + une fusion de `main` (veille Codex CLI, PR #7), sans conflit. **À ne pas fusionner automatiquement** : la décision appartient au propriétaire.

## Résumé des fonctionnalités

### DSers Basic
- Par défaut : « Indisponible — abonnement Basic ». Une garde côté serveur s'applique avant OAuth, rappel, renouvellement, test, synchronisation et appel, puis avant chaque requête : aucun réseau et aucun secret créé en Basic.
- Le plan est déclaré localement ; changer cette déclaration ne prouve aucune éligibilité côté DSers.
- Pour les plans éligibles : MCP officiel, OAuth 2.1 + PKCE (S256), sans clé d'API, 12 outils de lecture seulement.

### Import CSV Archipel
- Modèle téléchargeable, fichier local UTF-8, analyseur borné (500 Ko, 5 000 lignes, 40 colonnes, 2 000 caractères par cellule).
- Aperçu nettoyé, erreurs ligne par ligne, confirmation explicite, import dans une transaction atomique.
- Colonnes clients supprimées, suivis masqués, coût absent = `null` avec motif ; devise et nature obligatoires pour un coût renseigné.
- Aucun adaptateur d'export DSers Basic inventé : un export non vérifié est refusé proprement.

### Shopify Admin (préparé, non connecté)
- Exige un accord local daté confirmé **et** une autorisation réseau côté serveur ; un jeton d'environnement seul ne suffit pas.
- API `2026-10`, version réellement servie vérifiée. Portées : `read_products` + `read_inventory` ; `read_orders` autorisable séparément (60 jours maximum).
- Jamais de `read_customers`, `read_all_orders` ni `write_*`. Requêtes fixes, projection fermée sans champ client ni URL de suivi.
- Caches public et Admin distincts ; une tâche de communication ne lance jamais de relevé Admin. Le Shopify public garde son fonctionnement.

### 17TRACK
- Inchangé : non connecté sans clé ; seule une clé déjà existante peut être collée ; 3 points d'accès autorisés (`getquota`, `gettracklist`, `gettrackinfo`).

## Permissions et protections de sécurité
- **Accès individuel sans défaut** aux imports et à l'Admin : aucun agent n'appelle un service, il reçoit un bloc de données préparé par Archipel depuis des relevés en cache. Les dix agents restent inchangés.
- Provenance textuelle distincte, sources locales vérifiables, exclusion des tâches web, héritage sans escalade ; contenu absent du journal portable et de la mémoire générale.
- Listes blanches : 12 outils DSers, 3 points d'accès 17TRACK. Quotas inchangés.
- Secrets : stockage chiffré DPAPI / AES-GCM, jamais dans git ni dans les journaux ; connexion refusée et jetons supprimés si une portée non demandée est accordée.
- Conservation : imports 30 jours, caches Shopify 7 jours, purge à l'ouverture puis chaque minute (sans promesse d'effacement physique des sauvegardes).
- Détection des coordonnées et des secrets dans les champs libres du catalogue.

## Migrations de base de données
Toutes **additives**, sans suppression de données existantes :
- `integration_state`, `integration_grants`, `integration_calls` (+ index `integration_calls_day`), `integration_snapshots` (+ index `integration_snapshots_kind`) : créées si absentes (`CREATE TABLE IF NOT EXISTS`).
- `shop_meta` et `shop_admin_snapshots` : créées si absentes.
- Communication : migration versionnée `ALTER TABLE comm_tasks ADD COLUMN with_integrations TEXT NOT NULL DEFAULT '[]'` (retour arrière prévu par `DROP COLUMN` ; une base non vide est sauvegardée avant toute migration).
- Données locales à chaque ordinateur : rien ne voyage par git.

## Tests réalisés
Node 24, `node --test` sur `integration-center` après fusion de `main` : **474 réussis, 0 échec, 0 ignoré** (466 de la phase + 8 de la veille Codex). Simulateurs en mémoire et HTTP local uniquement. Régressions couvertes : Basic, CSV, projections et permissions Admin, révocation concurrente, provenance, atomicité, annonces de l'interface. Aucun secret ni donnée personnelle dans le diff (balayage des motifs de jetons et clés).

## Codex : veille préservée, runner désactivé
- **Codex Watch intact** : workflow, script, baseline, test et documentation sont identiques à `main` (différence vide). Permissions `contents: read` + `issues: write`, actions épinglées par empreinte de commit.
- **Runner Codex désactivé** : cette PR n'ajoute aucun runner Codex, aucune route PAL/`clink`, aucune option de contournement du bac à sable. Le refus fermé sur Codex est conservé.

## Limites connues
- **Aucune connexion réelle testée** : aucun compte DSers, 17TRACK ou Shopify, aucun OAuth fournisseur, aucune permission réelle, aucun réseau externe, aucune API payante. Les accords Admin testés vivent dans des bases de test.
- Aucun format d'export DSers Basic vérifié : utiliser le modèle Archipel (origine DSers déclarative). Compatibilité Shopify réelle et champs DSers à valider plus tard, sur autorisation séparée.
- Pagination Admin bornée et annoncée partielle ; blocs agent limités à 30 lignes par type.
- Détection des coordonnées et secrets heuristique ; des champs commerciaux peuvent contenir des noms ou adresses.
- Sauvegardes et archives historiques non purgées physiquement.
- Pas d'essai avec lecteur d'écran ni de test navigateur complet (contrôleur testé avec un DOM simulé).
- La veille Codex n'est pas encore vérifiée en exécution réelle : lancer le workflow une fois à la main après la fusion.

Détails et mode d'emploi : `docs/INTEGRATIONS.md`, `docs/SHOPIFY-LECTURE-SEULE.md`, `docs/CODEX-WATCH.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
