# Veille des versions de Codex CLI

Objectif : être prévenu quand une nouvelle version **stable** de Codex CLI pourrait lever un des trois blocages d'isolation (voir `docs/PAL-HARDENING.md`) et permettre de reprendre les tests. **Le suivi n'installe, ne met à jour et n'exécute jamais Codex** ; Codex reste refusé (refus fermé), aucune activation via PAL.

## Les trois blocages surveillés
1. Catalogue d'outils intégrés non restreint (`exec`, multi-agents… annoncés au modèle).
2. Chargement des skills et configurations du profil utilisateur (47 des 55 skills du vrai profil envoyés au modèle).
3. Impossibilité de restreindre le réseau à un fournisseur unique.

## Fonctionnement
`tools/codex-watch/check.mjs` (Node, zéro dépendance, lecture publique HTTPS seulement) :
1. lit la dernière version stable publiée (`dist-tags` du registre npm) ;
2. si elle dépasse la version testée (`tools/codex-watch/baseline.json`, aujourd'hui **0.164.0**), lit les notes des releases stables intermédiaires (X.Y.0 de chaque mineure + la dernière) sur l'API GitHub d'openai/codex ;
3. cherche, **ligne par ligne**, des formulations fortes liées à chaque blocage (par ex. `agents.enabled` pour couper les outils de sous-agents, « managed network proxy », « skill discovery », `--ignore-user-config`…). Un simple mot-clé ne suffit pas ; les nouveautés de modèles et du sandbox Windows ne sont que des **informations** ;
4. produit un rapport (versions pertinentes, lignes concernées, **tests nécessaires**) et n'en signale que si une version est pertinente. Si l'API GitHub est indisponible, la nouvelle version est signalée sans analyse inventée.

Hôtes autorisés : `registry.npmjs.org` et `api.github.com` (HTTPS, sans redirection, délai 15 s, 5 Mo max). Aucune donnée du projet ni du poste n'est envoyée ; aucune clé API. Dans GitHub Actions, seul le jeton éphémère `GITHUB_TOKEN` de l'exécution est utilisé, et uniquement vers `api.github.com`.

Utilisation locale (aucune installation) : `npm run codex:watch` (ou `node tools/codex-watch/check.mjs --out rapport.md`).

## Workflow GitHub Actions : `.github/workflows/codex-watch.yml`
- Déclenchement : chaque lundi 06:17 UTC + manuel. Permissions : `contents: read`, `issues: write`. Aucun secret du dépôt, aucune écriture de code (la baseline n'est **jamais** modifiée automatiquement).
- Étapes : récupération partielle du dossier `tools/codex-watch`, Node 24, analyse, résumé du job, rapport en artefact (30 jours), puis **une issue par version pertinente** (recherche de doublon sur le titre).
- **Ne tourne pas sur cette branche** : les exécutions planifiées ne partent que de la **branche par défaut**. Mise en service = actions distantes à approuver (ci-dessous).

### À valider avant mise en service (rien n'a été activé)
1. **Fusion du fichier dans `main`** (ou changement de branche par défaut) : sans cela, ni la planification ni le déclenchement manuel n'existent côté GitHub. Une fusion est interdite sans votre accord explicite.
2. GitHub Actions et les **issues** doivent être activés sur le dépôt ; la politique de permissions du jeton doit autoriser `issues: write` (réglages du dépôt, à vérifier côté GitHub).
3. Les actions tierces sont référencées par étiquette (`actions/checkout@v4`, `setup-node@v4`, `upload-artifact@v4`) : épingler par empreinte de commit après vérification est recommandé (non fait ici, aucune vérification possible hors ligne).
4. Aucune clé ni variable de dépôt à créer.
Alternatives sans fusion : exécution manuelle `npm run codex:watch`, ou une routine planifiée côté Claude (changement distant à autoriser séparément).

## Premier relevé réel (22/11/2026, baseline 0.164.0)
Dernière stable : **0.171.0** ; versions stables plus récentes : 0.165 à 0.171. Éléments à instruire (à confirmer par des sondes, **rien n'est prouvé par ce relevé**) :
- **Outils** : 0.168.0 mentionne `agents.enabled` pour désactiver les outils de sous-agents (avertissement quand `features.multi_agent` est configuré).
- **Réseau** : 0.167.0 « managed network requirements » (`permissions.network`), 0.169.0 et 0.171.0 « managed proxy / network proxy startup », routage TCP transparent (Linux). Reste à établir si un hôte/port unique peut être imposé côté client sous Windows.
- **Skills** : 0.168.0 « respect filesystem permissions when discovering repository skills » (ne dit rien de la découverte dans le profil utilisateur).
- **Modèles** : 0.171.0 ajoute **GPT-6.2 Sol et Astra** aux catalogues de modèles : c'est pourquoi « Astra » n'était pas visible avec 0.164.0.
- **Windows** : plusieurs correctifs du lanceur MXC (0.168 à 0.171).
Conclusion : la version 0.171.0 mérite un **test d'isolation séparé** (Windows), après décision du propriétaire d'installer cette version dans un cadre de test (changement système, hors de ce suivi).

## Tests à reprendre pour une version pertinente (Windows)
1. `ARCHIPEL_CODEX_PROBES=1 node --test test/codex-client-catalog.test.js`
2. `node --test test/codex-mxc.test.js test/codex-client-isolation.test.js`
3. Sonde réseau : prouver qu'un seul hôte/port est joignable (faux fournisseur + second port + 127.0.0.2).
4. Mettre à jour `docs/PAL-HARDENING.md` puis `baseline.json` **seulement après validation**.

## Limites
Détection heuristique (faux positifs et faux négatifs possibles : lecture humaine nécessaire) ; les correctifs X.Y.Z intermédiaires ne sont pas énumérés (seule la dernière version l'est) ; l'API GitHub non authentifiée est limitée en débit ; les tests nécessitant Windows restent à valider séparément.
