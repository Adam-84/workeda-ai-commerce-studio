# Runner Codex natif — Archipel

Implémentation indépendante, Node 24 ESM, bibliothèque standard seulement. Aucun code Sellbird lu ou repris. Aucun appel de modèle, de compte ou de service externe pendant le développement et les tests.

## État et limite bloquante

Le 22 novembre 2026, sur Windows, les commandes locales `codex --version`, `codex --help` et `codex exec --help` donnent **codex-cli 0.164.0**. L'aide annonce notamment `--json`, `--sandbox read-only`, `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--config` et `--cd`. L'aide globale expose `--ask-for-approval` avec `never`.

Ces options ne démontrent pas l'absence de **tous** les outils, de leur réseau, des instructions et hooks locaux, ni l'imposition de l'authentification ChatGPT plutôt qu'une éventuelle clé déjà configurée dans le CLI. Un répertoire temporaire et un sandbox en lecture seule ne suffisent pas à garantir qu'un outil ne lit aucun fichier extérieur. Aucun mode moins sûr n'est autorisé.

**Le point d'entrée de production `runCodex` refuse donc actuellement toute exécution de modèle**, après la détection version/aide seulement. La tâche passe à `blocked`, avec explication et sans repli Claude. Aucun numéro de version n'est imposé : les flags sont détectés, mais changer la version ne déverrouille pas le lancement. Il faudra une capacité officielle garantissant cette isolation, documentée et testée, pour ajouter un profil réellement exécutable. Aucune option non documentée n'est inventée.

Le transport JSON est implémenté et testé avec un faux CLI. Son export `codexTransport` est une primitive de bas niveau, **pas un point d'entrée autorisé de production** ; aucun appelant de l'application ne l'utilise directement. Il n'offre pas à lui seul la garantie d'absence de tous les outils. Il ne faut pas remplacer `runCodex` par ce transport pour contourner le refus.

## Contrat du fournisseur

`src/engine-provider.js` expose `createEngineProvider({ claude, codex })` et `run(engine, options)` :

- `engine` vaut strictement `claude` ou `codex` ; les valeurs héritées comme `constructor` sont refusées.
- Options : `system`, `prompt`, `tools`, `signal` (`AbortSignal`), `timeoutMs`, `maxTokens`, `onText`, `onEvent`. Le modèle Claude n'est pas envoyé à Codex, dont le modèle reste celui du CLI.
- Résultat : `{ text, engine, usage: { input, output } | null, costUsd: number | null, quota }`. Le coût Codex est toujours `null`, même si un fournisseur injecté retourne zéro.
- Événements normalisés : `text`, `usage`, `observation`, `completed`, `error`, avec `engine`. Les observations Claude enveloppent l'événement d'origine pour préserver la vérification des outils existante. Codex ne prouve aucune consultation web.
- Erreurs avec `code` : `unavailable`, `capability`, `auth`, `quota`, `privacy`, `protocol`, `output_limit`, `isolation`, `timeout`, `cancelled`, `budget`, `execution`. Aucun stderr brut n'est journalisé ni renvoyé.

L'ancien runner Claude qui retourne une chaîne et émet du stream-json reste accepté par l'adaptateur. `comm-run.js` utilise le fournisseur injecté. Une réponse Codex indisponible bloque la tâche sans reprise automatique. L'arrêt de l'orchestrateur transmet l'annulation aux exécutions Codex actives.

## Sélection et synchronisation

- Fiche agent → Profil → **Moteur local de l'agent** : Claude par défaut. Préférence dans `comm_meta`, jamais dans le journal portable.
- Comms → Déléguer → **Moteur de cette tâche** : préférence locale ou surcharge explicite. Le choix est figé à la création et entre dans le dédoublonnage. Les tâches existantes ne changent pas lorsqu'on modifie le réglage local.
- Les délégations vers un collègue prennent le moteur local du destinataire ; une surcharge de la tâche d'origine n'impose pas un moteur à tous les collègues.
- Migration additive Comms **v4** : `comm_tasks.engine`, `comm_runs.engine`, défaut historique `claude`, migration réversible avec la sauvegarde existante.
- Le journal transporte le moteur choisi, par slug d'agent. À l'import, `Object.hasOwn` distingue un ancien champ absent d'une valeur explicite. Un champ absent conserve un moteur déjà connu ; une valeur invalide refuse l'événement. Un import ne démarre aucune IA.
- Les anciens fils de discussion agrègent plusieurs missions sans provenance Comms. Pour un agent réglé sur Codex, ils demandent une tâche Comms explicite au lieu d'envoyer implicitement ce contexte ou d'appeler Claude.

Routes locales, avec les protections Host/Origin des autres routes Comms :

| Méthode et route | Fonction |
| --- | --- |
| `GET /api/comm/agents/:id/engine` | Lire le moteur local |
| `PUT /api/comm/agents/:id/engine` | `{ "engine": "claude" ou "codex" }` |
| `POST /api/comm/delegations` | Accepte `engine`, facultatif |
| `GET /api/comm/codex` | Limites et consommation locales, quota abonnement inconnu |
| `PUT /api/comm/codex/limits` | Modifier les limites locales |
| `GET /api/comm/codex/capabilities` | Version et aide uniquement, aucun modèle |

## Limites et coût inconnu

Défauts : 20 tentatives par jour UTC et par appareil, une exécution Codex simultanée par fournisseur d'application, 180 000 ms par exécution, 3 600 000 ms cumulées par jour et 100 000 jetons rapportés par jour. Réglages locaux persistants dans `comm_meta`, modifiables dans Comms → Activité ou par la route des limites. La limite globale Comms reste applicable.

Les tentatives enregistrées, y compris les refus de capacité après démarrage de la trace, comptent. Le compteur est reconstruit depuis les exécutions persistantes du même appareil ; il ne repart pas à zéro au redémarrage. Les fenêtres de quota de l'abonnement ne sont pas lues : aucune interface officielle stable n'a été établie par les sources locales autorisées. L'interface affiche **quota inconnu**.

Les jetons sont connus seulement si le JSON rapporte des entiers valides. Un seuil de jetons est **constaté après la réponse**, pas réservé en amont : la dernière exécution peut le dépasser. Un usage absent reste inconnu et est signalé ; les limites de tentatives et de durée continuent à s'appliquer. La durée restante réduit le timeout de l'appel suivant.

Une mission comportant Codex a `spentUsd: null` : **coût Codex inconnu**, jamais assimilé à 0 $. La dépense Claude connue/estimée reste séparée (`knownSpentUsd`) et soumise au plafond USD existant. Les exécutions Codex sont comptées en nombre, durée et jetons rapportés. `usage().today.costUsd`, le total et les totaux par agent restent inconnus quand ils incluent Codex ; `reportedCostUsd` désigne seulement le sous-total rapporté. Les anciennes estimations d'échec Claude n'incluent pas Codex.

## Transport, confidentialité et Windows

- Prompt sur stdin, arguments en tableau, `shell: false`. Aucun texte de mission dans la ligne de commande. Les shims npm `codex.cmd` sont résolus vers leur point d'entrée Node ; aucun interpréteur cmd/PowerShell n'est lancé. Un shim non reconnu est refusé.
- Probes et transport hors dépôt, dans un répertoire temporaire neuf. Le transport crée un sous-répertoire de travail vide et un HOME temporaire, nettoyés à la fin. Aucune instruction d'Archipel n'est lue par le transport.
- Environnement transmis par liste autorisée, sans PATH, clés API, variables Archipel, proxy ni `NODE_OPTIONS`. `CODEX_HOME` est uniquement le chemin de la configuration existante nécessaire à l'authentification CLI ; aucun fichier d'authentification n'est lu, copié ou journalisé par Archipel. L'absence de lecture des autres éléments de ce HOME par le CLI n'est pas présumée : c'est une raison du refus fermé actuel.
- Réutilisation de `catalog-privacy.js` / `scrubSecrets`, puis contrôle `containsPii` et `findSecret`, avant le fournisseur Codex et avant stdin. Contacts, suivis et secrets reconnus sont neutralisés ; les identifiants structurés de blocs déjà projetés restent typés. Aucun filtre ne prétend détecter toute donnée sensible inconnue.
- Les règles existantes Memory/Comms/intégrations continuent de sélectionner le contexte et sa provenance. Le filtrage ne confère aucun droit supplémentaire. Les données d'intégrations restent soumises aux droits par agent et à leur exclusion des tâches web.
- Parseur JSONL tolérant aux lignes invalides et aux fragments UTF-8, y compris la dernière ligne sans saut de ligne. Succès seulement avec `turn.completed`, texte final non vide et code de sortie nul. Un événement d'erreur reste un échec même si le processus retourne zéro. Tout item d'outil ou inconnu arrête le transport ; cette réaction n'est pas une garantie préventive d'isolation.
- Sorties stdout/stderr cumulées bornées à 1 Mo. Timeout/annulation/limite de sortie arrêtent l'arbre sous Windows via `taskkill.exe /PID … /T /F`, jamais par une commande construite depuis le prompt. Sous Unix, groupe de processus dédié et SIGKILL.

## Vérification sans compte

```powershell
node --test test/codex-runner.test.js test/engine-integration.test.js test/comm-run.test.js test/comm-store.test.js test/comm-api.test.js test/comm-view.test.js test/claude-reply.test.js
node --test
git status --short
```

Les tests Codex créent uniquement un script Node et un shim `.cmd` temporaires. Aucun test ne cherche le vrai exécutable Codex ni ne lance un modèle. Succès, lignes invalides, fragmentation, auth/quota absents, CLI absent, capacité manquante, sortie énorme, timeout, annulation et descendant de processus sont simulés. Les sources officielles utilisées sont les aides locales ci-dessus ; aucun réseau utilisé pour consulter la documentation publique. Références à consulter avant d'ajouter un profil sûr : documentation officielle OpenAI Codex CLI, `https://developers.openai.com/codex/cli/reference/` et `https://developers.openai.com/codex/config-reference/` (non consultées pendant ce travail hors réseau).
