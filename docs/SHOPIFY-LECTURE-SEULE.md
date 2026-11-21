# Shopify en lecture seule et budget par mission (Phase 5)

## Principe
Les agents peuvent s'appuyer sur le catalogue réel de workeda.com **sans aucune possibilité d'écrire dans la boutique**. Le Studio relève lui-même le catalogue (en lecture seule, daté) et le donne, à votre demande, à une délégation. L'agent ne parle jamais à Shopify.

## Deux modes de relevé
| Mode | Source | Identifiants | État |
| --- | --- | --- | --- |
| `public` (défaut) | `/collections.json` et `/products.json` de la boutique | aucun | **vérifié en réel** : 13 collections, 38 produits |
| `admin` | API Admin GraphQL, requêtes fixes | `SHOPIFY_ADMIN_TOKEN` + `SHOPIFY_ADMIN_DOMAIN` (xxx.myshopify.com), **variables d'environnement seulement** | testé avec une boutique simulée ; non vérifié en réel (aucun jeton fourni) |

Domaine de la boutique : `WORKEDA_SHOP_DOMAIN` (défaut `workeda.com`). Ne mettez jamais de jeton dans le dépôt : `.env` est ignoré par git. Un jeton sans domaine admin valide (ou l'inverse) n'est **jamais** utilisé : mode public et avertissement.

## Garanties (vérifiées par des tests)
- Aucune écriture : aucun `PUT/PATCH/DELETE` dans le code ; un seul `POST`, la requête GraphQL **de lecture** ; les deux requêtes sont des constantes sans `mutation` (contrôle au chargement du module et par test). Aucune requête n'est construite à partir d'un texte d'agent ou de message.
- Un seul hôte autorisé, HTTPS, **aucune redirection suivie** (le jeton ne part jamais ailleurs), délai 15 s, corps lu au fil de l'eau et abandonné au-delà de 5 Mo.
- Jeton : uniquement dans l'en-tête de la requête Admin ; absent des retours d'API, des erreurs, des prompts, de la base et des journaux git.
- Politesse : un relevé au plus toutes les 5 minutes (échecs compris) ; au premier `429` tout le relevé s'arrête et `Retry-After` est respecté, même si on force.
- Le texte donné à l'agent est cadré « données non fiables », daté, avec les limites du relevé ; sans relevé : « non disponible », rien n'est inventé.
- `withCatalog` ne vient que du propriétaire ; une sous-tâche d'agent ne fait qu'hériter (consolidations comprises). L'empreinte anti-doublons en tient compte.
- Un résultat qui cite le relevé est « vérifié » (`observed`) avec la mention « catalogue Shopify daté fourni par le Studio » : l'agent ne l'a pas consulté lui-même.
- Le relevé est un cache **local** : chaque ordinateur relève le sien, rien n'est synchronisé par git.

## Budget par mission
Chaque demande racine a un budget (3 $ par défaut, 0,10 à 100 $), réglable dans le Comms Center. Il compte le coût rapporté par Claude Code de **toutes** les exécutions de la demande : tâches, sous-tâches, consolidations, erreurs et réponses données dans le fil de la mission. Au-delà, plus aucune nouvelle exécution ne démarre (celles en cours finissent), les tâches concernées sont bloquées avec explication, et augmenter le budget les relance, consolidations comprises. Une exécution sans coût rapporté compte pour 0 : le budget est un garde-fou, pas une facture.

## Migration
`COMM_MIGRATIONS` v2 : colonnes `with_catalog` et `budget_usd` (additives, sauvegarde avant, réversible). Un journal écrit avant la v2 s'importe sans effacer un budget ou un catalogue déjà connus. Nouvelle table locale `shop_snapshots` (8 relevés conservés).

## Routes
`GET /api/shop/status`, `GET /api/shop/catalog`, `POST /api/shop/refresh` (machine locale uniquement) ; `POST /api/comm/tasks/:id/budget`. Aucune autre route Shopify : toute écriture répond 404.

## Limites connues
- Le mode Admin n'a pas pu être essayé sur la vraie boutique (pas de jeton) : à vérifier au premier branchement.
- Le mode public ne voit que ce que la boutique publie (pas de brouillons, de coûts ni de stocks exacts).
- `products.json` a répondu `429` à un client de test depuis ce poste, mais pas au connecteur : le comportement dépend de la boutique ; le relevé dégrade proprement.
- Les connecteurs `shopify-admin` déclarés dans les fiches restent « non connectés » dans l'interface des fiches : le relevé passe par le Studio, pas par l'agent.
- Aucune écriture Shopify n'existe encore. La suite logique est une file de **propositions** à valider, jamais une écriture directe.
