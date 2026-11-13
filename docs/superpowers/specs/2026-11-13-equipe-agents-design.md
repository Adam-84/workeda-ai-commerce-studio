# Équipe d'agents Workeda — spécification

Date : 2026-11-13 · Statut : à valider · Chantier 1 sur 6 (voir section 9).

## 1. Objectif

Donner aux 10 agents de Workeda une vraie fiche de poste, écrite une seule fois et utilisée à deux endroits :

- dans Claude Code, où chaque fiche est un sous-agent appelable par son prénom ;
- dans l'app, où la fiche s'affiche dans l'onglet Profil du personnage.

Les agents sont préchargés au démarrage. Leur statut reste « En attente — source : manual » : ce chantier ne fait travailler aucun agent depuis l'app.

## 2. Hors périmètre

- Lancer un agent depuis l'app, afficher l'outil en cours ou le coût (chantier 2).
- Validations, cerveau, sous-agents visibles sur l'île, vues Tâches / Calendrier (chantiers 3 à 6).
- Connexion à Shopify, DSers ou Playwright. Le calculateur de marges n'est pas créé.
- Modifier une fiche depuis l'app : une fiche se modifie dans son fichier.
- Toute dépendance npm : le projet reste sans dépendance.

## 3. Les fichiers d'agents

### 3.1 Emplacement

Un fichier par agent : `.claude/agents/<slug>.md`, où `<slug>` est le prénom en minuscules (`alexander.md`, `olivia.md`…). Ces fichiers sont versionnés dans Git.

### 3.2 En-tête

L'en-tête est un bloc `---` de lignes `clé: valeur` sur une seule ligne chacune. Les listes sont séparées par des virgules. Claude Code lit `name`, `description`, `tools` et `model` ; il ignore les autres clés, que l'app utilise.

| Clé | Obligatoire | Valeur |
| --- | --- | --- |
| `name` | oui | le slug, identique au nom du fichier |
| `description` | oui | quand faire appel à cet agent, en une phrase |
| `tools` | oui | outils Claude Code autorisés |
| `model` | oui | `opus`, `sonnet` ou `haiku` |
| `display_name` | oui | prénom affiché (`Alexander`) |
| `role` | oui | rôle affiché dans l'app |
| `department` | oui | nom exact d'un département existant |
| `collaborates` | oui | slugs des collègues, ou `tous` |
| `connectors` | non | outils externes attendus (voir 5.3) |

### 3.3 Corps

Huit sections, dans cet ordre, avec ces titres exacts :

| Titre | Contenu |
| --- | --- |
| `## Métier` | une phrase : ce que fait l'agent |
| `## Ne fait jamais` | les interdits propres au poste |
| `## Missions` | responsabilités principales |
| `## Règles` | le socle commun (3.4) puis les règles du poste |
| `## Méthode` | étapes numérotées |
| `## Livrable` | format fixe du résultat rendu |
| `## Relais` | à qui passer quoi |
| `## Réussite` | critères vérifiables |

Les fiches sont rédigées en français.

### 3.4 Socle commun

Ces règles figurent mot pour mot dans la section `## Règles` de chaque fiche :

1. N'invente jamais un prix, un chiffre, une date ou une promesse. Si une donnée manque, écris « donnée manquante ».
2. Chaque chiffre porte sa source et sa date de relevé.
3. Si un outil dont tu as besoin n'est pas connecté, dis-le et travaille avec ce qu'on te fournit.
4. Tu prépares, tu n'exécutes pas : toute écriture sur Shopify (thème publié, prix, commande) reste une proposition à faire valider.
5. Quand la demande est claire, ne pose pas de question inutile : fais une hypothèse raisonnable, note-la, avance.

## 4. Les 10 agents

Les fiches s'inspirent des agents du dépôt [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) (licence MIT). Elles sont réécrites pour Workeda, pas copiées.

| Slug | Département | Rôle | Modèle | Outils Claude Code | Connecteurs | Collabore avec | Inspiré de |
| --- | --- | --- | --- | --- | --- | --- | --- |
| alexander | Direction | Directeur général IA | opus | Read, Grep, Glob | — | tous | Agents Orchestrator, Chief of Staff |
| olivia | Direction | Coordinatrice des missions | sonnet | Read, Grep, Glob | — | tous | Project Shepherd |
| sophia | Laboratoire | Analyste de marché e-commerce | sonnet | WebSearch, WebFetch, Read, Grep, Glob | web | noah, lucas, alexander | Trend Researcher |
| noah | Laboratoire | Analyste de veille concurrentielle | sonnet | WebSearch, WebFetch, Read, Grep, Glob | web, shopify-admin | sophia, isabella, chloe | Trend Researcher |
| lucas | Catalogue | Responsable catalogue Shopify | sonnet | Read, Grep, Glob | shopify-admin | isabella, chloe, benjamin | Cross-Border E-Commerce Specialist |
| isabella | Catalogue | Analyste des prix et marges | sonnet | Read, Grep, Glob | shopify-admin, dsers | noah, lucas, benjamin | Pricing Analyst |
| chloe | Création | Designer UX/UI e-commerce | sonnet | WebFetch, Read, Grep, Glob | web, shopify-admin | sophia, ryan, harper | UX Architect, UX Researcher |
| ryan | Création | Développeur Shopify | opus | Read, Edit, Write, Grep, Glob, Bash | shopify-cli, codex-cli | chloe, harper, olivia | Frontend Developer |
| harper | Opérations | Responsable contrôle qualité | sonnet | Read, Grep, Glob, Bash | shopify-cli, playwright | ryan, chloe, alexander | Reality Checker, Evidence Collector |
| benjamin | Données | Analyste des performances commerciales | sonnet | Read, Grep, Glob | shopify-admin | alexander, lucas, isabella | Analytics Reporter |

Règles propres à chaque poste, en plus du socle :

- **Alexander** découpe une demande en pièces indépendantes, donne le même cadre à chaque agent et relit avant de livrer. Un sous-agent Claude Code ne peut pas en lancer d'autres : Alexander rend donc un plan qui nomme l'agent de chaque pièce, et c'est la session principale qui les appelle.
- **Olivia** suit les dépendances et les blocages. Elle ne décide pas des priorités : elle les demande à Alexander.
- **Sophia** analyse peu de sources mais à fond, et termine par cinq recommandations adaptées à Workeda.
- **Noah** rapporte des constats, jamais de critiques d'un concurrent. Chaque prix relevé porte son lien et sa date.
- **Lucas** classe ses optimisations par priorité et ne modifie aucune fiche produit.
- **Isabella** affiche sa formule et ses hypothèses (TVA, livraison, frais). Elle ne modifie aucun prix.
- **Chloe** audite le parcours d'achat sur mobile d'abord. Avec WebFetch elle lit le HTML et le CSS : tout constat visuel est « déduit du code, non vu », et panier et paiement ne s'auditent que sur captures fournies.
- **Ryan** n'écrit que dans une copie locale du thème. Les seules commandes Shopify CLI qu'il lance sont `shopify theme pull` et `shopify theme check` ; toute autre (dev, share, push, publish, delete, rename, duplicate) est proposée, jamais lancée. Il ne lance jamais `shopify theme push` ni `shopify theme publish`.
- **Harper** conclut « À corriger » par défaut et exige une preuve pour chaque point validé. Elle n'a pas d'outil de capture : sans capture fournie, le point est « donnée manquante ». Ses seules commandes sont `shopify theme check`, `npm test`, `git status`, `git diff` et `git log`.
- **Benjamin** indique la période et la source de chaque indicateur.

## 5. Côté serveur

### 5.1 Lecture des fichiers — `src/agent-files.js`

Deux fonctions sans effet de bord sur la base :

- `parseAgentFile(text, filename)` renvoie `{ profile }` ou `{ error }`. Une fiche est invalide si une clé obligatoire manque, si `name` diffère du nom de fichier, si `model` est inconnu ou si une des huit sections manque.
- `loadAgentFiles(dir)` lit tous les `.md` du dossier et renvoie `{ profiles, warnings }`. Un dossier absent donne deux listes vides.

Les fiches sont lues une fois, au démarrage. Une modification demande de relancer `npm start`.

### 5.2 Synchronisation — `studio.syncAgentFiles(profiles)`

Nouvelle table, créée avec `CREATE TABLE IF NOT EXISTS` ; les tables existantes ne sont pas modifiées :

```sql
agent_files (agent_id TEXT PRIMARY KEY REFERENCES agents(id), slug TEXT NOT NULL UNIQUE, linked_at TEXT NOT NULL)
```

Pour chaque fiche, dans l'ordre :

1. Le slug est déjà lié : rien ne change. Le nom, le rôle et le département modifiés dans l'app sont conservés.
2. Sinon, un agent porte déjà ce `display_name` (sans tenir compte de la casse) : il est lié à la fiche, sans autre modification.
3. Sinon, l'agent est créé dans son département et lié. L'événement `agent.hired` est émis (source `manual`), avec le détail « recruté depuis .claude/agents/<slug>.md ».

Si le département n'existe pas, la fiche est ignorée et un avertissement est ajouté. Un agent n'est jamais supprimé : si un fichier disparaît, l'agent reste, sans fiche.

`syncAgentFiles` renvoie `{ created, linked, warnings }`. Relancer le serveur ne crée aucun doublon.

### 5.3 État des connecteurs

L'app n'affirme pas qu'un outil est connecté. Quatre états possibles :

| Connecteur | État |
| --- | --- |
| `shopify-cli`, `codex-cli` | `detected` ou `missing`, d'après la détection déjà utilisée par `/api/health` (`detect`) |
| `shopify-admin`, `dsers`, `playwright` | `not_connected` (aucun connecteur dans le projet) |
| `web` | `claude_code_only` : disponible quand l'agent tourne dans Claude Code |

### 5.4 Routes

| Méthode | Route | Effet |
| --- | --- | --- |
| `GET` | `/api/agent-profiles` | liste les fiches liées : `agentId`, `slug`, `model`, `tools`, `connectors` (`id`, `state`), `collaborates` (`slug`, `agentId` ou `null`) et les huit sections en texte |
| `GET` | `/api/health` | ajoute `agentFiles: { loaded, warnings }` |

Un agent sans fiche n'apparaît pas dans la liste. Si `collaborates` vaut `tous`, la route renvoie `collaboratesAll: true` et une liste `collaborates` vide.

## 6. Côté app

### 6.1 Onglet Profil

Pour un agent lié à une fiche, l'onglet Profil affiche, sous le statut existant :

- la phrase de la section Métier ;
- une pastille de modèle (Opus, Sonnet ou Haiku) ;
- les connecteurs avec leur état en toutes lettres : « détecté », « non détecté », « non connecté », « dans Claude Code uniquement » ;
- « Collabore avec » : un bouton par collègue, qui recentre la carte sur lui et ouvre sa fenêtre ; `tous` s'affiche « Toute l'équipe » ;
- le livrable attendu ;
- un bloc repliable « Fiche complète » avec les autres sections ;
- une ligne d'aide : « Dans Claude Code, demande : "<Prénom>, …" ».

Pour un agent sans fiche, l'onglet reste tel qu'aujourd'hui.

### 6.2 Avertissements

Si `agentFiles.warnings` n'est pas vide, la ligne de connexions de la barre du haut (`#connections`) l'indique (« 1 fiche ignorée ») et le panneau Réglages liste le fichier et la raison.

## 7. Erreurs

- Fiche invalide ou département inconnu : fiche ignorée, avertissement visible, le serveur démarre.
- Dossier `.claude/agents` absent : aucun agent préchargé, aucun avertissement.
- Collègue cité mais absent de l'équipe : il s'affiche en texte, sans bouton.

## 8. Tests (`node --test`)

- `test/agent-files.test.js` : fiche valide ; clé manquante ; section manquante ; `name` différent du fichier ; modèle inconnu ; dossier absent.
- `test/agent-sync.test.js` : création des 10 agents ; second passage sans doublon ; liaison d'un agent déjà recruté à la main ; département inconnu ; agent renommé dans l'app non écrasé.
- `test/agent-profiles-api.test.js` : `GET /api/agent-profiles` ; états des connecteurs ; `agentFiles` dans `/api/health`.
- Un test charge les 10 fiches réelles du dépôt et vérifie qu'elles sont toutes valides et contiennent le socle commun.

Le README est mis à jour : section « Équipe d'agents », usage dans Claude Code, mention de la licence MIT d'agency-agents.

## 9. Suite

Chaque chantier aura sa propre spec, dans cet ordre :

2. Moteur réel : une mission lance l'agent, statut vérifié, outil en cours, coût.
3. Validations : boîte « À valider », Valider / Refuser.
4. Cerveau : mémoire commune datée.
5. Sous-agents : clones dans l'atelier de l'île, relecture par le chef.
6. Vues Tâches et Calendrier adaptées à Workeda.
