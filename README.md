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
- **Personnage** : onglets Discussion, Missions, Profil (statut et source), Apparence et Activité.
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

Un clic sur un personnage ouvre un panneau avec Discussion, Missions, Profil, Apparence et Activité. Sur petit écran, ce panneau occupe tout l'écran.

Dans Discussion, vous écrivez en tant que **Vous**, avec des bulles et un horodatage. Les anciens messages entre agents restent visibles avec leur expéditeur et leur destinataire. Les messages utilisateur sont conservés dans la nouvelle table `user_messages` ; aucune table existante n'est réécrite.

Cette messagerie **enregistre seulement les messages dans la base du Studio** : aucun modèle IA n'est appelé et aucune réponse n'est simulée. Une base propre à chaque PC reste une base séparée.

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
