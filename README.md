# Workeda AI Commerce Studio — MVP local

Un tableau de bord local pour organiser les départements et agents IA de `workeda.com`, sans prétendre qu’un agent ou un connecteur travaille lorsqu’il ne l’est pas.

## Ce qui fonctionne maintenant

- 8 départements initiaux, plus ajout dynamique de départements ;
- recrutement d’agents, base SQLite et journal d’événements ;
- missions, messages inter-agents et traçabilité ;
- statuts avec source (`manual`, `claude`, `codex`, `shopify`) : une activité externe non vérifiée est refusée ;
- détection réelle (et affichée telle quelle) de Shopify CLI, Claude Code, Codex CLI et clink ;
- carte Pixel Art **isométrique** d’îles flottantes (canvas, sans image ni asset externe), avec ciel selon l’heure ;
- personnalisation des îles (nom affiché, couleurs, décor, emblème), voir ci-dessous.
- 10 agents préchargés depuis `.claude/agents/`, chacun avec sa fiche de poste, utilisables aussi dans Claude Code (voir « Équipe d'agents »).

## Naviguer sur la carte

Archipel isométrique à l'échelle 1:1 (personnages 64×64) : la place centrale et son cristal, entourés d'une île par département. Chaque île porte un bâtiment en coupe (murs, fenêtres, porte) meublé selon le métier.

- **Glisser** pour déplacer la carte, **molette** ou boutons +/− (Réglages) pour zoomer (50 %, 100 %, 200 %). Flèches du clavier quand la carte a le focus.
- **Mini-plan** (bas droite) : un clic recentre la carte sur une île.
- **Pastille au-dessus d'un bâtiment** : agents, missions, recrutement.
- **Parcelle « + »** : recruter un agent (nom, rôle, département prérempli, puis confirmation). Il entre par la porte et rejoint son bureau.
- **Personnage** : onglets Discussion, Missions, Profil (statut et source), Apparence, Activité et Skills.
- **Barre du bas** : donner une mission à un agent (crée une vraie mission, validation requise).
- **Recherche** (barre du haut) : met en évidence les agents dont le nom ou le rôle correspond et liste jusqu’à 8 résultats ; les autres agents restent visibles.

Les faisceaux lumineux ne représentent que de vrais messages ou missions ; les échanges des dernières 24 h restent visibles en pointillés.

## Personnaliser une île

Cliquez sur une île ou sur sa pastille : la fenêtre s’ouvre avec les onglets « Agents (n) », « Missions » et « Personnaliser ». Réglages disponibles :

| Réglage | Options |
| --- | --- |
| Nom affiché | texte libre, 24 caractères max : lettres, chiffres, espaces, point, tiret, apostrophe et accents français. Vide = nom du département |
| Couleurs | accent, sol de la pièce, murs |
| Décor extérieur | sol de la plateforme : herbe, sable, neige, pavés ; arbres : ronds, sapins, palmiers, cerisiers ; lanternes : par défaut, oui, non |
| Emblème | aucun, ou couronne, colis, pinceau, mégaphone, casque, camion, graphique, fiole |

- L’aperçu s’affiche en direct sur la carte pendant la modification. **Annuler**, **Échap** ou la fermeture de la fenêtre restaurent l’apparence enregistrée.
- **Enregistrer** écrit dans la base SQLite. **Revenir à l’identité d’origine** supprime la personnalisation.
- Le mobilier reste lié au métier du département. Le vrai nom du département n’est jamais modifié : la base et les libellés d’accessibilité gardent le nom d’origine, seul le nom affiché change. Sur la carte, ce libellé utilise la police pixel, qui ne connaît que ses propres caractères : un caractère absent est refusé.

Stockage : nouvelle table `island_styles` (clé `department_id`, puis `label`, `accent`, `floor`, `wall`, `emblem`, `tree`, `ground`, `lanterns`, `updated_at`), créée avec `CREATE TABLE IF NOT EXISTS` ; les tables existantes ne sont pas modifiées. Les valeurs sont des jetons (`gold`, `ice`, `grass`…) ; `NULL` = défaut.

| Méthode | Route | Effet |
| --- | --- | --- |
| `GET` | `/api/island-styles` | liste les personnalisations |
| `PUT` | `/api/departments/:id/style` | enregistre le style. Remplacement complet : un champ absent revient au défaut. `400` si une valeur est inconnue ou si le libellé est invalide, `404` si le département n’existe pas |
| `DELETE` | `/api/departments/:id/style` | supprime la personnalisation. `404` si le département n’existe pas |

Ces actions écrivent dans le journal : `island.style.updated` et `island.style.reset` (source `manual`, sans agent).

## Personnages

Personnages 64×64 originaux, générés par couches (coiffure, couleurs, peau, tenue, accessoire). Apparence automatique stable, modifiable dans l'onglet Apparence (enregistrée dans la table `agent_appearance`). Les onglets des fenêtres (agent, île) se parcourent au clavier : flèches, Début et Fin. L'expression et l'attitude suivent uniquement le statut enregistré :

| Statut | Expression | Icône |
| --- | --- | --- |
| `idle` | calme | aucune |
| `working` | concentré, tape au clavier | engrenage |
| `waiting` | interrogatif | sablier |
| `blocked` | soucieux | panneau orange |

### Déposer vos propres sprites

Les sprites doivent être en 64×64 (frames de 64×64, pieds à `anchorX` 32, `anchorY` 61). Voir [public/assets/characters/README.md](public/assets/characters/README.md) : feuilles PNG par état + `manifest.json` avec un champ `license` **obligatoire** (sinon les sprites sont ignorés). Ne déposez que des fichiers dont vous possédez la licence (CC0, CC-BY avec attribution, achat) ; conservez le texte de licence à côté. Aucun asset n’est téléchargé automatiquement.

## Cycle du ciel

Le sélecteur **Ciel** (panneau Réglages : bouton ⚙ ou pastille de phase dans la barre du haut) propose Automatique (défaut), Matin, Midi, Soir et Nuit.

| Phase | Heure locale du navigateur | Ambiance |
| --- | --- | --- |
| Matin | 05:00–09:59 | ciel clair, soleil bas, brume légère |
| Midi | 10:00–16:59 | bleu lumineux, nuages légers |
| Soir | 17:00–20:59 | orange et violet, lanternes et fenêtres allumées |
| Nuit | 21:00–04:59 | étoiles, lune, lumières chaudes, routes aériennes lumineuses |

Toute l'interface (barres, fenêtres, pastilles) change de couleurs avec la phase. La pastille de la barre du haut indique la phase, l'heure et le mode (auto ou manuel) ; un clic ouvre les réglages.

Un choix manuel remplace l’automatique (mémorisé dans le navigateur, `localStorage`) ; « Automatique » revient à l’heure. Il n’y a aucune météo.

Ce MVP ne se connecte pas à Shopify, ne modifie aucun thème, ne modifie aucun prix et ne passe aucune commande. Il ne contient ni clé API ni secret.

## Équipe d'agents

### Discussion avec un personnage

Un clic sur un personnage ouvre un panneau avec Discussion, Missions, Profil, Apparence, Activité et Skills. Sur petit écran, ce panneau occupe tout l'écran.

Dans Discussion, vous écrivez en tant que **Vous**, avec des bulles et un horodatage. Les anciens messages entre agents restent visibles avec leur expéditeur et leur destinataire. Les messages utilisateur sont conservés dans la nouvelle table `user_messages` ; aucune table existante n'est réécrite.

Les messages sont enregistrés dans la base du Studio. **Chaque agent relié à une fiche `.claude/agents/<prénom>.md` répond réellement** : à chaque envoi, le serveur lance `claude -p` avec le modèle et la fiche de l'agent comme consigne. Le contexte contient les 50 derniers messages de la discussion et les missions dont l'agent est responsable, collaborateur ou demandeur (au plus 10), avec leur mémoire non archivée (au plus 20 notes par mission). Les liens des missions sont signalés comme des références non consultées. La réponse s'affiche au fil de l'eau, puis est conservée dans la table `agent_replies`. Un agent recruté à la main, sans fiche, ne répond pas ; aucune réponse n'est simulée. Les agents ne se contactent pas entre eux depuis la Discussion.

### Discussion d'équipe d'une mission

Chaque fiche de mission a un fil « Discussion d'équipe » qui réunit vous, le responsable et les collaborateurs (table `mission_discussion`). Vous écrivez, puis vous cochez qui répond : les agents choisis parlent l'un après l'autre, responsable d'abord, et chacun lit la mission, sa mémoire non archivée et les 50 derniers messages du fil, y compris les réponses de ses collègues, présentées comme écrites par d'autres agents IA. Chaque réponse est un appel réel à Claude Code, sans outil ; une seule réponse à la fois par mission. Les agents ne prennent jamais la parole d'eux-mêmes. Le bouton « Retenir » d'un message en fait une note de mémoire (type au choix, auteur du message comme source) : rien n'est retenu automatiquement.

### Mes consignes

L'onglet Profil d'un agent contient « Mes consignes » : objectif principal, priorités, préférences de travail et limites particulières, 2000 caractères au plus chacune (table `agent_instructions`). Elles sont transmises à l'agent dans Discussion et dans les discussions d'équipe, avec le contexte de la mission. Elles complètent la fiche `.claude/agents/<prénom>.md` sans la réécrire et sont placées entre la fiche et les règles de la messagerie : elles ne donnent ni outil, ni accès au web ou à Shopify, et ne lèvent aucune restriction ; en cas de contradiction, l'agent suit sa fiche et le signale.

### Plan d'action d'une mission

La fiche d'une mission contient une section « Plan d'action » (tables `mission_plans` et `plan_decisions`). « Proposer un plan » est un appel explicite à Claude Code : le responsable, avec ses consignes, prépare des étapes (action, agent responsable, résultat attendu, prérequis) à partir de l'objectif, des contraintes, de la mémoire et des échanges de la mission, et signale les informations manquantes. « Rédiger moi-même » crée un plan sans IA. Chaque version est figée : modifier, réordonner, ajouter ou retirer une étape, changer un responsable ou demander une révision avec des indications crée une nouvelle version à valider ; les versions précédentes et vos décisions (validation, refus, commentaire) restent. Une décision porte sur la version courante précise. Valider ne lance aucune étape et n'accorde aucun accès (Shopify, web, fichiers, commandes). L'état des étapes (à faire, en cours, bloquée, terminée) est déclaré à la main par l'utilisateur ; une réponse d'agent ne le change jamais. Les agents reçoivent la version courante du plan avec son statut ; une proposition leur est présentée comme non validée.

Pour ces réponses, Claude tourne sans aucun outil (`--tools ""`), sans serveur MCP (`--strict-mcp-config`), sans hooks, plugins ni CLAUDE.md (`--safe-mode`), sans enregistrer de session, dans le dossier temporaire du système : pas d'accès aux fichiers, aux commandes ni à Shopify. La connexion Claude Code déjà ouverte sur le PC est utilisée telle quelle ; le Studio ne lit aucun jeton. Si l'appel échoue (Claude absent, déconnecté, limite atteinte), votre message reste enregistré, l'erreur s'affiche et un bouton permet de redemander la réponse. Une base propre à chaque PC reste une base séparée.

Le champ accepte les messages de plus de 500 caractères. L'historique n'est plus tronqué à huit messages : « Messages précédents » charge les échanges par pages de 50, sans plafond sur le nombre total consultable. La protection serveur sur la taille des requêtes reste active (environ 1 Mo de texte JSON). Un refus garde le brouillon pour permettre de le corriger.

Entrée envoie ; Maj+Entrée ajoute une ligne. Le brouillon est conservé par agent pendant la visite, y compris après changement d'onglet ou fermeture du panneau ; un rechargement de page l'efface. Un échec d'envoi conserve le texte. Le bouton « Missions » permet aussi de préparer une mission pour le personnage sélectionné.

API : `GET /api/agents/:id/conversation?before=<curseur>` renvoie `{ items, nextCursor }` et `POST /api/agents/:id/conversation` avec `{ body }` enregistre un message utilisateur. Les anciennes routes `/api/messages` restent compatibles.

Au premier démarrage, dix agents sont recrutés à partir de leur fiche dans `.claude/agents/` :

| Département | Agents |
| --- | --- |
| Direction | Alexander (directeur général IA), Olivia (coordination des missions) |
| Laboratoire | Sophia (marché), Noah (veille concurrentielle) |
| Catalogue | Lucas (catalogue Shopify), Isabella (prix et marges) |
| Création | Chloe (design UX/UI), Ryan (développement Shopify) |
| Opérations | Harper (contrôle qualité) |
| Données | Benjamin (performances commerciales) |

- **Dans l'app** : cliquez un personnage, onglet Profil. Vous y voyez son métier, son modèle, ses outils avec leur état réel, ses collègues (un clic vous emmène vers eux), le livrable attendu et la fiche complète.
- **Dans Claude Code**, ouvert dans ce dossier : demandez par exemple « Sophia, analyse le marché des bougies parfumées » ou « Alexander, découpe cette demande ». Claude Code lit la même fiche.
- Les agents restent « En attente — source : manual » : l'app ne fait encore travailler aucun agent.
- États des outils : « détecté » ou « non détecté » (le programme est présent ou non sur l'ordinateur), « non connecté » (Shopify Admin, DSers, Playwright : aucun connecteur dans le projet), « dans Claude Code uniquement » (recherche web).
- Une fiche se modifie dans son fichier, puis on relance `npm start`. Une fiche invalide est ignorée : la barre du haut l'indique et le panneau Réglages donne la raison. Les changements de `display_name`, `role` et `department` ne comptent que pour un agent pas encore recruté ; pour un agent déjà dans l'app, seuls les textes de l'onglet Profil sont mis à jour.
- Un agent déjà recruté à la main avec le même prénom est relié à sa fiche sans être modifié : il garde son nom, son rôle et son département, et un redémarrage ne les écrase pas. Aucun agent n'est jamais supprimé.
- Route de lecture : `GET /api/agent-profiles`. `GET /api/health` indique aussi `agentFiles` (fiches chargées, fiches ignorées).

Les fiches s'inspirent des agents du dépôt [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents), sous licence MIT. Elles sont réécrites pour Workeda : aucun fichier n'est copié.

## Skills des agents

Un Skill est un dossier `skills/<nom>/SKILL.md` : des consignes en texte, rien d'autre. La bibliothèque contient 19 Skills Workeda, répartis entre les dix agents (deux par agent), et un fichier `skills/catalog.json` (catégories, versions, métiers, dépendances, sources examinées).

- **Dans l'app** : le bouton **Skills** de la barre du haut ouvre le centre Skills (bibliothèque avec recherche et filtres, détail, création, modification avec nouvelle version, archivage, import GitHub, état des copies). L'onglet **Skills** d'une fiche agent liste ses Skills préchargés, des suggestions pour son métier et les Skills disponibles.
- **Qui fait foi** : le dossier `skills/` et la ligne `skills: [...]` de chaque fiche `.claude/agents/<agent>.md` (quatre Skills au plus par agent). La base SQLite n'en est que le reflet : aucune table existante n'est modifiée, chaque PC la reconstruit depuis le dépôt, donc la synchronisation entre ordinateurs passe par git.
- **Claude Code et Codex** : `.claude/skills/` (Skills préchargés par au moins un agent) et `.agents/skills/` (tous les Skills actifs) sont des copies générées, marquées `.archipel-managed`. Un dossier sans ce marqueur n'est jamais écrasé et rien n'est supprimé. Quand un Skill est archivé, bloqué ou n'est plus préchargé, sa copie générée est désactivée (son `SKILL.md` devient `SKILL.md.inactive`, donc plus lu par les outils) ; elle est réactivée si le Skill redevient voulu. Un Skill refusé par l'analyse de sécurité ou invalide pour l'un des deux outils n'est jamais copié. Un éditeur ouvert avant une autre modification ne peut pas l'écraser (erreur 409 : rouvrez le Skill).
- **Jetons** : seuls les Skills listés dans la fiche d'un agent sont chargés à son démarrage. Les chiffres affichés sont une estimation (caractères ÷ 4), pas une mesure faite par un modèle.
- **Sécurité** : un Skill ne donne ni outil ni permission. Archipel ne télécharge de l'import que le fichier `SKILL.md` (https, hôtes GitHub, 64 Ko au plus), ne lance aucun script, refuse les contenus signalés « bloquant » et n'écrase jamais un Skill existant. L'import se fait en deux temps : un aperçu sans rien écrire, puis la confirmation. Les actions d'écriture n'acceptent que les requêtes locales.
- **Statistiques d'usage** : elles ne viennent que de déclarations manuelles ; Archipel n'exécute aucun agent et ne peut pas mesurer l'usage réel.

```powershell
npm run skills:check   # contrôle sans rien écrire (Skills, fiches, dépendances, copies)
npm run skills:sync    # régénère .claude/skills et .agents/skills
```

Les changements de Skills s'appliquent au **prochain démarrage de Claude Code** : la liste des agents est lue au lancement. Pour vérifier qu'un agent utilise bien ses Skills, relancez Claude Code dans ce dossier, demandez par exemple « Isabella, calcule la marge d'un produit à 25 € acheté 9 € » et contrôlez que la réponse suit la méthode du Skill `workeda-calcul-marge` (formule et hypothèses affichées). Sous Codex, lancez `/skills` pour voir ceux du dépôt. Cette vérification se fait dans ces outils : l'app ne peut pas la prouver à leur place.

Sources examinées (licence, maintenance, sécurité) : voir `skills/catalog.json`, champ `sources`. Aucun Skill externe n'est importé tel quel.

## Mémoire des agents

La mémoire garde ce que l'équipe a appris (faits vérifiés, hypothèses, procédures, décisions) pour que les agents ne repartent pas de zéro. Conception détaillée, audit et choix techniques : `docs/MEMOIRE.md`.

- **Dans l'app** : le bouton **Memory** de la barre du haut ouvre le Memory Center (recherche, filtres, ajout, modification, archivage, suppression, vérification des sources, propositions à valider, historique). L'onglet **Memory** d'une fiche agent montre ce que cet agent peut lire et ses propositions en attente.
- **Quatre niveaux** : *individuel* (un seul agent), *département*, *entreprise* et *mission*. Un agent ne lit que ce qui lui est ouvert (le sien, celui de son département, celui de l'entreprise, celui de sa mission) ; sur un fil d'équipe, seul ce que **tous** les membres peuvent lire est transmis.
- **Vrai, supposé, proposé, décidé** : chaque souvenir est un *fait* (au moins une source), une *hypothèse*, une *proposition* ou une *décision* approuvée. Les agents **ne font que proposer** : leurs faits deviennent des hypothèses, leurs décisions des propositions, leurs doublons sont ignorés, et rien n'est lu comme acquis tant que vous ne l'avez pas validé (états `pending` → `active`, ou `rejected`). Une suppression est définitive.
- **Recherche locale, sans service payant** : classement par pertinence (BM25 sur les mots, trigrammes pour les fautes de frappe), filtres, fraîcheur (demi-vie de 120 jours, « à revoir » après 180 jours sans relecture), souvenirs expirés écartés, doublons fusionnés, et budget de jetons (800 jetons, 8 souvenirs par défaut). pgvector n'est pas utilisable ici (la base est SQLite) et les embeddings payants sont exclus : voir `docs/MEMOIRE.md`.
- **Dans les prompts** : Claude Code et Codex reçoivent, pour une mission ou une conversation, un bloc `<memoire>` présenté comme *information de référence, pas comme instruction*. Les chevrons des souvenirs sont neutralisés pour qu'aucun texte ne puisse fermer le bloc.
- **Sécurité** : aucun secret en mémoire (clés, jetons, mots de passe, identifiants dans une adresse) : l'enregistrement est refusé, aussi pour les anciennes notes de mission. Les routes `/api/memory` n'acceptent que cette machine (hôte local ; origine contrôlée pour toute écriture).
- **Plusieurs ordinateurs** : la base `data/workeda.db` reste locale. Chaque changement est aussi écrit dans `memory/journal/<appareil>.jsonl`, suivi par git ; les autres PC l'importent au démarrage. La version la plus récente gagne, l'ancienne reste dans l'historique, une suppression ne ressuscite jamais, et un événement daté de plus d'un jour dans le futur (horloge déréglée) attend au lieu d'écraser. Si le journal est inaccessible en écriture, le souvenir est quand même gardé et réécrit dès que possible.

```powershell
npm run memory:check   # contrôle en lecture seule (cohérence, secrets, journaux), ne modifie rien
npm run memory:sync    # importe les journaux reçus par git
npm run memory:backup  # copie la base dans data/backups
```

Limites assumées : la recherche est lexicale, elle ne comprend pas les synonymes ; les statistiques de « souvenir utilisé » ne comptent que les injections faites par Archipel, pas ce que le modèle en a réellement fait.

## Communication entre agents

Les agents échangent, se délèguent du travail et remontent leurs résultats ; vous gardez la main. Conception, audit et limites : `docs/COMMUNICATION.md`.

- **Dans l'app** : le bouton **Comms** (avec le nombre de notifications ; un point vert quand un agent travaille réellement) ouvre le Comms Center : **Fils** (privés, départements, missions, groupes, avec statut envoyé / reçu / traité / erreur), **Délégations** (arbre des sous-missions, validation, résultat à vérifier, relance, annulation), **Notifications**, **Activité** (exécutions réelles, coûts rapportés, quota, synchro). L'onglet **Comms** d'une fiche agent résume ses fils et ses tâches.
- **Rien ne part tout seul** : écrire un message n'appelle aucune IA. Un agent travaille seulement sur une tâche approuvée, ou si vous cliquez « Faire répondre ». Deux agents actifs au maximum, 60 exécutions par jour.
- **Les agents demandent, le Studio contrôle** : un agent ne contacte jamais un collègue directement ; il demande, et le Studio vérifie les droits de sa fiche (`collaborates`), la profondeur (3), les boucles, les doublons. Selon la mission, vous validez ses demandes.
- **Pas de « terminé » sans preuve** : une tâche n'est terminée qu'avec un résultat vérifié (sources réellement consultées par l'agent, ou consolidation de résultats vérifiés). Sinon elle passe « À vérifier » et c'est vous qui la validez.
- **Recherche web, lecture seule** : à votre demande (case à cocher), et seulement pour un agent dont la fiche prévoit `WebSearch`/`WebFetch`. Aucune écriture Shopify, aucune API payante (Claude Code, abonnement existant).
- **Plusieurs ordinateurs** : journal `comm/journal/<appareil>.jsonl` (git). Un import recopie des données et **ne lance rien** ; une tâche reçue d'un autre PC se reprend explicitement (« Exécuter ici »).

```powershell
npm run comm:check              # contrôle en lecture seule
npm run comm:sync               # importe les journaux reçus par git
npm run comm:inbox -- sophia    # ce qui attend un agent (utilisable depuis Codex)
npm run comm:tasks              # liste des délégations
```

## Shopify en lecture seule et budget

Les agents peuvent s'appuyer sur le catalogue réel de workeda.com, **sans jamais pouvoir écrire dans la boutique**. Détails et garanties : `docs/SHOPIFY-LECTURE-SEULE.md`.

- **Catalogue** : dans une délégation, cochez « Fournir le catalogue Shopify ». Le Studio le relève lui-même (pages publiques, sans identifiant ; l'API Admin en lecture seule est possible avec `SHOPIFY_ADMIN_TOKEN` et `SHOPIFY_ADMIN_DOMAIN` dans l'environnement, jamais dans le dépôt), le date et le donne à l'agent comme donnée non fiable. Section **Activité** du Comms Center : dernier relevé et bouton « Relever le catalogue maintenant » (au plus toutes les 5 minutes ; un `429` de la boutique est respecté).
- **Budget** : chaque demande a un budget (3 $ par défaut) calculé sur le coût rapporté par Claude Code ; au-delà, plus aucune nouvelle exécution ne démarre, et vous pouvez l'augmenter.
- Rien n'est écrit sur Shopify : une modification serait une proposition, que vous seul exécutez.

## Integration Center : DSers et 17TRACK en lecture seule

Bouton **Integrations** : connexions DSers (MCP, OAuth + PKCE) et 17TRACK (clé existante), états réels, permissions, quotas (100 appels DSers/jour, configurable), accès **agent par agent (aucun par défaut)**, révocation. Archipel ne modifie jamais DSers, 17TRACK ni Shopify, ne transmet aucune donnée personnelle de client aux agents et masque les numéros de suivi. Le réseau réel reste **verrouillé** tant que `ARCHIPEL_ALLOW_REAL_NETWORK=1` n'est pas défini avec votre accord. Détails, coûts, limites : `docs/INTEGRATIONS.md` (audit : `docs/INTEGRATIONS-AUDIT.md`).

## Prérequis Windows

Node.js 24 ou plus récent. Vérifier dans PowerShell :

```powershell
node --version
```

## Installer et démarrer

Depuis ce dossier :

```powershell
npm test
npm start
```

Ouvrir ensuite [http://localhost:4318](http://localhost:4318). La base locale est créée à `data/workeda.db` et est ignorée par Git. Pour essayer sans toucher à vos données : `$env:WORKEDA_DB="C:\temp\essai.db"; npm start`.

Routes de lecture ajoutées pour la carte : `GET /api/messages` (récents, filtre `?missionId=`) et `GET /api/events?agentId=`. Apparences : `GET /api/appearances`, `PUT /api/agents/:id/appearance` (enregistre) et `DELETE /api/agents/:id/appearance` (retour à l’automatique), stockées dans la nouvelle table `agent_appearance` ; les tables existantes ne sont pas modifiées. `POST /api/activity` n'accepte que la source `manual` (403 sinon) : les sources `claude`, `codex` et `shopify` ne pourront être enregistrées que par un futur connecteur serveur vérifié. « Détecté » (barre en haut de la carte) signifie seulement que le programme est présent sur l’ordinateur, pas qu’il est connecté.

Pour changer le port pour la session :

```powershell
$env:PORT=4320; npm start
```

## Sécurité et vérité des statuts

Un personnage apparaît après recrutement ; il ne signifie pas qu’un modèle tourne. Par défaut, il est **En attente — source : manual**. Un futur connecteur devra envoyer un événement vérifié avant de faire passer un agent à « working », « waiting » ou « blocked ».

Les futures actions Shopify suivront cette règle : inspection/GraphQL Admin API en lecture seule d’abord ; création d’une copie non publiée du thème ensuite ; toute écriture (publication de thème, prix, commande) exige une validation humaine spécifique et enregistrée.

## Inspiré par Pixel Office

Le produit est inspiré du principe d’interface de [bignutchanon/pixel-office](https://github.com/bignutchanon/pixel-office), dont le dépôt est sous licence MIT et visualise localement les événements réels de Claude Code/Codex. Ce MVP ne copie pas son code ou ses assets : il emploie une interface et un modèle de données originaux. Si du code ou des assets sont repris plus tard, conserver la notice MIT et vérifier la licence de chaque asset séparément.

## Prochaines étapes testables

1. Connecteur local de lecture des sessions Claude/Codex, avec horodatage et preuve de source.
2. Détection Shopify CLI, sélection explicite d’un magasin et commande `theme pull` vers une copie locale uniquement.
3. Lecture GraphQL Admin API avec jeton stocké hors du dépôt ; écran de validation des changements proposés.
4. Intégrations DSers et pricing derrière validations distinctes, sans automatisation de prix ni commande.

Voir aussi [docs/MVP-ROADMAP.md](docs/MVP-ROADMAP.md).
