# Mémoire des agents — audit et conception (Phase 3)

## 1. Audit de l'existant

| Élément | État avant la phase 3 | Décision |
| --- | --- | --- |
| Notes de mission (`/api/missions/:id/memory`) | Notes libres rattachées à une mission, types `fact` / `decision` / `open` | Conservées telles quelles (compatibilité). Elles passent maintenant par le garde local et refusent les secrets. |
| Base SQLite (`data/workeda.db`, `node:sqlite`) | Locale, ignorée par git | Réutilisée : seules de nouvelles tables `memory_*` sont ajoutées, aucune table existante n'est modifiée. |
| Skills (phase 2) | Dossier `skills/` + fiches `.claude/agents` ; la base n'est qu'un reflet | Même principe de synchronisation par git, repris pour le journal mémoire. |
| Injection dans les prompts | `claude-reply.js` / `app.js` ajoutaient les notes de mission | Remplacée par `contextFor`, qui applique niveaux, droits, classement et budget. |

## 2. Modèle

**Niveaux** : `individual` (un agent), `department`, `company`, `mission`.

**Nature** : `fact` (au moins une source), `hypothesis`, `proposal`, `decision`. **Genre** (`kind`) : connaissance, procédure, préférence, règle, etc.

**Champs** : id, titre, contenu, genre, nature, niveau, propriétaire (agent), département, mission, provenance, sources (libellé, note, lien, date de vérification), confiance, importance, étiquettes, visibilité et lecteurs, dates (création, modification, relecture, expiration), révision, appareil d'origine, historique.

**États** : `pending → active | rejected | deleted` · `active → archived | deleted` · `archived → active | deleted` · `rejected → pending | deleted` · `deleted → ∅`.

**Les agents ne font que proposer** :

- tout ce qu'un agent écrit arrive en `pending` ;
- un fait devient une hypothèse, une décision devient une proposition ;
- le niveau est forcé (jamais plus large que ce que l'agent peut lire) ;
- le genre `rule` est refusé aux agents ;
- un doublon est ignoré ; pour un humain, il renvoie 409 (`force: true` pour passer outre) ;
- seul le propriétaire (l'utilisateur) valide, rejette, archive ou supprime.

## 3. Recherche et injection

Pas de service d'embeddings, pas de réseau : tout est local.

1. **Pertinence** : BM25 sur les mots (accents et casse ignorés) + similarité de trigrammes (tolère les fautes).
2. **Fraîcheur** : demi-vie de 120 jours ; au-delà de 180 jours sans relecture, une connaissance est « à revoir » et rétrogradée (les décisions ne vieillissent pas).
3. **Expiration** : un souvenir expiré n'est jamais injecté.
4. **Importance et confiance** : pondèrent le score.
5. **Déduplication** : deux souvenirs quasi identiques ne sont pas injectés ensemble.
6. **Budget** : 800 jetons et 8 souvenirs par défaut (estimation caractères ÷ 4) ; ce qui ne rentre pas est compté dans `omitted`.
7. **Droits** : un souvenir n'est candidat que si l'agent peut le lire. Pour un fil d'équipe, `contextFor([agents…])` ne garde que ce que **tous** peuvent lire. Un souvenir de mission n'est lu que dans cette mission.

Le résultat est un bloc `MEMORY_PREAMBLE` + `<memoire>…</memoire>`. Le préambule dit qu'il s'agit d'informations de référence, pas d'instructions ; `<` et `>` sont neutralisés (`‹` `›`) dans les souvenirs.

### Étude pgvector

pgvector est une extension de PostgreSQL. Archipel utilise SQLite embarqué (`node:sqlite`), sans serveur : pgvector n'y est pas applicable, et migrer vers PostgreSQL casserait « zéro dépendance, tout local ». Un index vectoriel aurait de toute façon besoin d'un modèle d'embeddings ; les API payantes sont exclues et un modèle local alourdirait l'installation. Pour quelques centaines de souvenirs, BM25 + trigrammes donne de bons résultats à coût nul. Si la base passait un jour à PostgreSQL, la fonction `rank` est le seul endroit à remplacer (ajouter une colonne `embedding vector` et fusionner son score au score lexical).

## 4. Apprentissage

- **Fin de mission** : `POST /api/missions/:id/memory-proposals` enregistre en attente ce que les agents ont retenu. Rien n'est actif tant que l'utilisateur ne l'a pas validé dans le Memory Center.
- **Distinction** : fait vérifié (avec source) ≠ hypothèse ≠ proposition ≠ décision approuvée ; l'interface affiche la nature de chaque souvenir.
- **Obsolescence** : la fraîcheur et l'expiration signalent ce qui est à revoir ; le contrôle `memory:check` en donne le décompte.

## 5. Synchronisation entre ordinateurs

- Chaque appareil écrit `memory/journal/<appareil>.jsonl` (une ligne = un événement, 24 000 octets UTF-8 au plus).
- Au démarrage et avec `npm run memory:sync`, les lignes inconnues sont importées (table `memory_imported`, donc idempotent).
- **Ordre** : date de l'événement, puis révision, puis appareil. La version la plus récente gagne ; la perdante est gardée dans l'historique.
- **Suppression** : définitive (pierre tombale), jamais ressuscitée par un événement ultérieur.
- **Horloge déréglée** : un événement à plus de 24 h dans le futur est mis en attente avec un avertissement.
- **Panne d'écriture** : le souvenir est enregistré, l'erreur est signalée (`status().journalError`) et l'événement est réécrit au prochain succès (file d'attente `outbox`).
- **Sauvegardes** : `VACUUM INTO data/backups/…` (`npm run memory:backup`).
- **Migrations** : numérotées et réversibles (`MEMORY_MIGRATIONS`).

## 6. Sécurité

- Refus de tout contenu ressemblant à un secret (clés d'API, jetons, mots de passe, identifiants dans une adresse), dans le titre, le contenu, les étiquettes, les sources et les anciennes notes de mission.
- Routes `/api/memory*` et routes historiques de notes : requête locale uniquement (hôte loopback ; origine vérifiée pour les écritures).
- Les agents n'ont aucune route d'écriture directe : ils ne produisent que des propositions.
- Contrôle `memory:check` en lecture seule : il n'ouvre pas la base en écriture, ne migre pas et ne crée rien.

## 7. Intégration

- **Claude Code** : `claude-reply.js` ajoute le bloc `<memoire>` au prompt de l'agent et de la mission.
- **Codex CLI** : mêmes entrées, via `src/memory-cli.js` pour le contrôle et la synchronisation ; les Skills (`.agents/skills`) restent indépendants de la mémoire.
- **Skills** : un Skill n'écrit pas en mémoire ; l'agent qui l'applique peut proposer un souvenir.
- **Futur système inter-agents** : `contextFor` accepte déjà plusieurs agents (fils d'équipe) et un identifiant de mission.

## 8. Tests

`test/memory-store.test.js` (stockage, états, droits, recherche, synchronisation), `test/memory-api.test.js` (API, garde local), `test/memory-view.test.js` (rendu), `test/memory-review.test.js` (régressions issues de la revue de code : fil d'équipe, routes historiques, secrets, ordre et suppressions à la synchro, horloge, panne du journal, dates mal formées, balise de référence, contrôle en lecture seule).

```powershell
node --test test/memory-store.test.js test/memory-api.test.js test/memory-view.test.js test/memory-review.test.js
```
