# Durcissement du routage PAL → Codex

22/11/2026 — branche `pal-hardening`, base `6fd965a`, arbre initial propre.

**Livré mais inactif. Aucun changement de configuration active/globale. Aucun fournisseur appelé.** Le nouveau gate refuse toute exécution, même avec un accord et un profil fictifs. Le PAL existant reste dangereux pour Codex : aucun blocage réel de cette instance n'est revendiqué tant que le propriétaire n'a pas installé une protection dans Claude Code. Aucun commit/push/fusion.

## Inventaire vérifié en lecture seule

Racine PAL ci-dessous : `%USERPROFILE%/tools/pal-mcp-server`. Les chemins sont relatifs à cette racine sauf indication Archipel. Audit du disque, pas d'appel d'outil PAL ni d'interrogation du serveur vivant. Aucune lecture d'auth.json. Recherche des lanceurs : `rg -n 'subprocess|create_agent|ClinkTool|clink.agents' tools clink server.py providers`. Aucun autre lanceur CLI trouvé dans le code de production audité ; ceci ne prouve pas l'impossibilité d'un lancement indirect par un CLI autonome.

| Route / déclencheur | Commande et sources exactes | Environnement, protections, risque |
|---|---|---|
| Claude Code → `mcp__pal__clink` | Déclaration `%USERPROFILE%/.claude.json`, serveur `pal` : `.pal_venv/Scripts/python.exe server.py` ; pas d'env explicite. `server.py` enregistre `tools/clink.py:CLinkTool` | Droits/env du parent ; pas de confinement apporté par MCP. Déclaration globale seulement lue, non modifiée. Présence dans une session Claude donnée à vérifier avec `/mcp`, sans lancer clink. |
| `clink(cli_name="codex")` | `tools/clink.py:execute` → `create_agent` (`clink/agents/__init__.py`) → `CodexAgent` (`clink/agents/codex.py`) → `BaseCLIAgent.run` (`clink/agents/base.py:111`) | `asyncio.create_subprocess_exec`, résolution `shutil.which` via PATH, sans shell ; hérite cwd si non configuré. Sans shell ne signifie pas sans outils. |
| Commande Codex livrée PAL | `clink/constants.py:INTERNAL_DEFAULTS` ajoute `exec` ; `conf/cli_clients/codex.json` ajoute `--json --dangerously-bypass-approvals-and-sandbox --enable web_search_request` | Supprime sandbox et approbations Codex ; droits PC/réseau du compte Windows. Le flag web est demandé ; effet runtime non testé. Timeout 1800 s par défaut ; flux 10 Mio par stream (pas un quota total de consommation). |
| Rôles et composition | default/planner/codereviewer ; fichiers `systemprompts/clink/default.txt`, `default_planner.txt`, `codex_codereviewer.txt` ; `role_args` actuellement vides | `BaseCLIAgent._build_command` concatène executable/internal_args/config_args/role_args. Prompts, références de fichiers et continuation composés par `_prepare_prompt_for_role` ; aucun filtrage Archipel automatique. Un rôle n'est pas une permission. |
| Continuation | `tools/clink.py:execute`, `get_request_continuation_id`, mémoire PAL | `cli_name` est toujours sélectionné dans la requête ou par défaut ; continuation n'est pas un raccourci sûr. Elle transporte du contexte historique, potentiellement sensible. Sans cli_name : préférence Gemini, sinon premier client. Le hook refuse l'omission, même avec continuation. |
| Config remplaçant la commande | `clink/registry.py:ClinkRegistry._iter_config_files/_resolve_config` : `conf/cli_clients` → `CLI_CLIENTS_CONFIG_PATH` (fichier/dossier) → `%USERPROFILE%/.pal/cli_clients` | Dernier client homonyme gagne. Aucun override utilisateur trouvé dans cet audit. Nom arbitraire rejeté par INTERNAL_DEFAULTS ; un alias doit réutiliser un nom reconnu et peut remplacer sa commande. Env={} ne supprime aucun héritage. |
| Chargement des variables | `utils/env.py:reload_env/get_env`, import à effet de bord ; `BaseCLIAgent._build_environment` (`base.py:202`) copie `os.environ` puis surcharge | PAL/.env peut réintroduire clés et configuration. `PAL_MCP_FORCE_ENV_OVERRIDE` peut rendre les valeurs .env prioritaires sur CLI_CLIENTS_CONFIG_PATH. PATH change le binaire résolu ; HOME/USERPROFILE changent les surcharges. PYTHONPATH/NODE_OPTIONS et variables des CLI sont des surfaces de démarrage. |
| Autres clink | Gemini : `gemini -o json --yolo` ; Claude : `claude --print --output-format json --permission-mode acceptEdits --model sonnet`, plus `--append-system-prompt` ; agy : `agy -p <prompt>` | Tous héritent env/cwd ; Gemini sans confirmation, Claude autorise des éditions, aucun flag de bypass constaté pour agy. `agy` met le prompt dans argv. Ces clients autonomes peuvent à leur tour lancer un programme, dont Codex, si leurs outils le permettent : non testé. Aucun durcissement appliqué à ces fournisseurs. |
| `chat`/`codereview`/`consensus` avec modèle « codex » | `providers/registry.py:get_provider_for_model` ; `conf/openai_models.json` alias codex → gpt-5-codex ; `openrouter_models.json` alias codex → openai/gpt-5-codex | Route API, pas `clink` ni abonnement CLI. chat/workflows → generate_content ; consensus consulte aussi des providers en interne. Aucun appel réalisé. Le hook clink ne couvre pas ces API ; la résolution dépend des providers/configs disponibles. |
| Autres PAL | thinkdeep et workflows : providers ; apilookup : instructions de recherche ; listmodels : inventaire | Aucun appel à clink/sous-processus CLI trouvé depuis ces outils. Les noms de modèles ne choisissent pas le runner CLI. Une réponse peut néanmoins inciter le parent à consulter clink. |
| Archipel | `src/app.js:createApp` → `src/engine-provider.js:createEngineProvider` → `src/codex-runner.js:runCodex` ; tâches/réponses `src/comm-run.js`, moteur `src/studio-comm.js:agentEngine/createTask` | Dix profils : défaut claude ; surcharge explicite codex sans repli. Détection version/aide puis safe=false : tour refusé. `codexTransport` exporté est un transport bas niveau, pas une autorisation, ne doit jamais contourner runCodex. |
| Agent Ryan / shell direct | Projet `.claude/agents/ryan.md:38` mentionne `codex exec --sandbox read-only`, outils Bash autorisés | Instruction textuelle, aucun confinement du shell ; ne passe pas par le hook clink. Proposition de règle ci-dessous ; fichier agent non modifié. |

Variables constatées par **nom seulement**, présentes dans l'environnement courant et/ou déclarées par PAL : GEMINI_API_KEY, OPENAI_API_KEY, AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, XAI_API_KEY, DIAL_API_KEY, OPENROUTER_API_KEY, DEFAULT_MODEL, DEFAULT_THINKING_MODE_THINKDEEP, CONVERSATION_TIMEOUT_HOURS, MAX_CONVERSATION_TURNS, LOG_LEVEL, DISABLED_TOOLS, PAL_MCP_FORCE_ENV_OVERRIDE, COMPOSE_PROJECT_NAME, TZ, LOG_MAX_SIZE. Noms de routage audités : CLI_CLIENTS_CONFIG_PATH, OPENAI_MODELS_CONFIG_PATH et les chemins de registres des autres fournisseurs. Aucune valeur affichée ni reproduite ; environnement effectif du serveur vivant non attesté.

**Codex First passé via le clink par défaut disposait d'un accès complet selon les droits Windows hérités.** Cela établit une capacité, pas la preuve d'un accès personnel ou d'une exfiltration effectifs. Aucune revue ponctuelle n'est lancée ici.

## Protections livrées et statut

- `tools/pal-hardening/guard-clink.mjs` : hook stdin JSON borné (256 Kio, 4 s), exit 2/message générique sans réafficher le contexte. Tous les serveurs `mcp__…__clink`, Codex/casse/espaces/alias inconnus/missing cli_name bloqués. Rôles et continuation ne changent pas la décision. Seuls claude/gemini/agy reconnus passent (exit 0 silencieux, **pas** une approbation de leurs actions).
- JSON illisible : impossible de savoir si l'outil était Codex ; donc refus conservateur. Enveloppe valide d'un autre outil : passage, même si tool_input est absent. Un clink avec client inconnu est bloqué pour couvrir les alias ; les autres fournisseurs reconnus restent inchangés.
- `tools/pal-hardened/pal-analysis-gate.mjs` : toujours exit 2, stdout vide, réponse structurée stderr. Flags dangereux diagnostiqués ; aucun argument n'autorise une exécution. Pas d'import child_process, aucun spawn. Environnement vidé sauf SystemRoot/WINDIR ; cwd temporaire neuf dans le projet supprimé en finally. Aucun stdin/contexte, profil, accord ou config utilisateur lu. Le Node lancé par PAL a initialement hérité de son environnement : le nettoyage JavaScript ne peut annuler un NODE_OPTIONS déjà traité. Ce gate ne remplace pas une frontière système.
- `tools/pal-hardened/cli_clients/codex.json` : nom compatible codex, commande gate, trois rôles, web disabled, env={}, timeout 5 s ; aucune commande dangereuse. Le chargeur ajoute `exec`, reçu seulement comme argument du gate. Le chemin relatif suppose le working_dir déclaré ; un vrai futur lanceur devra résoudre Node et gate en absolu.
- `start-instance.mjs` : exclusivement `--dry-run`, affiche commande proposée, nom de serveur `pal-hardened`, cwd dédié et variables par **noms**. Aucun serveur démarré, aucun dossier créé par ce dry-run. Toute tentative d'activation échoue.
- `check-pal-loader.py` : sonde optionnelle du chargeur réel uniquement ; stubs pour utils.env/file_utils empêchant le chargement .env ; ne construit pas ClinkRegistry (qui lirait les configs actives). Ne prouve pas qu'une instance PAL complète est isolée.
- `owner-approval.example.json` : schéma proposé, approved=false. Les fichiers `owner-approval.local.json` et `verified-isolation.local.json` sont ignorés par Git, jamais créés ici. Aucun accord ne lève le refus du code livré.

### Configurations proposées, NON APPLIQUÉES

Aucun de ces snippets n'est installé automatiquement. `<PROJET>` est à remplacer par un chemin absolu contrôlé avant toute validation manuelle. Aucun changement global n'est requis pour proposer un hook projet ; son installation dans une config **active** exige une décision distincte du propriétaire.

1. Variante grossière `.claude/settings.json` : fusionner `tools/pal-hardening/settings-deny.proposed.json`, soit `+ permissions.deny: ["mcp__pal__clink"]`. Bloque tous les clients de ce clink, donc ne convient pas si Gemini/Claude doivent rester disponibles. Aucun sélecteur cli_name fiable dans un fichier settings MCP : les règles mcp__ avec parenthèses y sont ignorées selon la [doc permissions](https://code.claude.com/docs/en/permissions#match-by-input-parameter). Le CLI `--disallowedTools` documente une distinction par paramètre, à valider sur version locale ; pas proposé comme garantie universelle.
2. Variante ciblée (préférée) : fusionner `tools/pal-hardening/settings-hook.proposed.json` dans `.claude/settings.json` :

```diff
+ "hooks": { "PreToolUse": [{ "matcher": "mcp__.*__clink", "hooks": [{
+   "type": "command", "command": "node \"<PROJET>/tools/pal-hardening/guard-clink.mjs\"",
+   "timeout": 5, "onFailure": "block"
+ }] }] }
```

Exit 2 bloque PreToolUse ; exit 0 conserve les permissions normales. `onFailure:block` couvre crash/timeout selon la [doc hooks](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails). **Compatibilité du câblage avec le Claude Code installé non exercée** : vérifier version, `/hooks` et invocation synthétique après accord, sans modèle. Si le champ est absent/non supporté, pas d'installation présentée comme sûre. Hook non exécuté → pas de protection. Ne remplace pas les permissions shell/les autres serveurs MCP.
3. Instance distincte `.mcp.json` : ajout proposé dans `tools/pal-hardened/mcp.proposed.json` :

```diff
+ "pal-hardened": { "command": "node",
+   "args": ["<PROJET>/tools/pal-hardened/start-instance.mjs"], "env": {} }
```

Ce snippet reste volontairement non opérationnel : le lanceur refuse sans --dry-run ; avec dry-run il imprime le plan puis termine. Ne pas l'installer en attendant un vrai bootstrap audité. Aucun changement au serveur `pal` existant. Un env={} MCP ne filtre pas le parent.
4. Instruction Ryan / protocole Codex First, proposition non appliquée : remplacer l'autorisation shell directe par « aucune délégation Codex par shell ou clink standard ; uniquement instance vérifiée après accord ponctuel ». Une instruction n'est pas une barrière technique ; permissions shell et capacités des autres CLI restent à traiter si l'objectif devient une interdiction complète, hors périmètre de ce routage.
5. **Aucun diff global proposé comme nécessaire** : ni `.claude.json`, ni `~/.codex`, ni PAL/.env/conf ne sont modifiés. Un futur bootstrap doit neutraliser .env et surcharges utilisateur sans réutiliser les configs actives ; démarrer le server.py existant avec seulement un HOME neuf et CLI_CLIENTS_CONFIG_PATH n'y suffit pas. Aucun bootstrap actif livré.

### Codex First et accord propriétaire

Possible comme mode **futur**, exclusivement via l'instance vérifiée, pas comme exception du hook vers PAL standard. Accord hors Git : dated approvedAt/expiresAt, serveur exact, empreinte profil et contexte nettoyé, une seule consultation, consommation atomique, expiration courte. Refuser accord périmé, réutilisé ou modifié, et toute continuation non liée à l'accord. Un fichier/env modifiable par l'agent ne constitue pas une preuve d'accord externe. Cette version ignore tous ces indicateurs et refuse même s'ils existent ; leur validation et provenance seraient un chantier ultérieur. Rien d'activé par défaut.

## Preuves et limites

`test/pal-hardening.test.js` exerce les scripts par leur vraie entrée processus : refus du hook, passage autres clients/outils, JSON invalide et volumineux, flags dangereux, refus du gate même avec faux accord/profil. Faux codex avec compteur vérifié positivement puis remis à zéro : reste absent après tous les refus. Diagnostic gate : cwd vide et seulement noms d'env autorisés. Lint config et rôles : échoue si le flag de contournement PAL est introduit. Lanceur refuse tout démarrage, dry-run sans valeurs sensibles. Chargeur PAL : accepte codex/gate, rejette nom inconnu, ne récupère aucun flag dangereux interne. Le parseur Codex réel rejette stdout vide/stderr de refus : CodexAgent ne peut pas récupérer ce refus comme un succès. Skip explicite si PAL/Python indisponible.

Intégration Archipel : dix tâches sous runner Claude fictif ; choix défaut claude pour dix agents ; demande codex vers le vrai runCodex avec exécutable fictif : seules --version et exec --help, tâche blocked, coût null, aucune bascule/retry. Ce test prouve le routage, **pas une inférence Claude réelle**. Aucun compte connecté ni modèle invoqué pour la validation.

Les tests historiques MXC utilisent le vrai CLI sans appel fournisseur externe et les témoins fictifs/loopback ; ils restent distincts des nouveaux faux CLI. La capture catalogue/appel forcé demeure non prouvée (skip existant). Validation sur ce poste : ciblés **32/32** ; suite complète **511 réussis / 512**, zéro échec, **un skip historique catalogue/appels forcés** (précondition réseau non résolue), 24,82 s. Les 503 réussites historiques sont préservées et huit tests ajoutés. Résultats à relancer sur la machine cible.

## Conditions de réexamen et activation

Déclencheurs : changement codex-cli/app-server/PAL/Claude Code, mode officiel sans outils, filtrage hôte/port imposé, `readOnly.access` disponible dans schéma local, canal fournisseur imposé et non contournable. Un numéro de version ou une option acceptée ne suffit jamais.

1. Version/aides/schéma locaux sans modèle ; comparaison à la doc officielle ; pas de flags dangereux.
2. Refaire témoins positifs et refus de lecture hors racines, écritures hors temporaire, héritage enfants, accès configs/skills/hooks/MCP. Ne jamais employer :minimal comme preuve de liste blanche.
3. Refaire réseau : loopback autorisé précis ET second port/127.0.0.2/autres chemins refusés ; proxy non contournable sur le **client entier**. Réseau désactivé actuellement bloque aussi le provider local.
4. Capturer catalogue annoncé via faux provider et forcer shell/apply_patch/lecture : aucun effet, aucun processus ou réseau résiduel. Vérifier contenu réel des instructions envoyées, pas seulement une feature false.
5. Authentification légitime abonnement sans extraction de credentials ; aucune clé ou lecture auth pour la preuve. Pas de passage à une API payante implicite.
6. Arrêt de l'arbre complet sur timeout/crash ; Job Object et imbrication MXC à démontrer. Échec/ambiguïté = refus fermé.
7. Bootstrap indépendant : sources de config/env et commande résolues, approbation fiable hors contrôle agent, réponse texte non exécutable, aucune action automatique, tests d'injection et anti-boucle.

Commandes locales, sans modèle :

```text
node tools/pal-hardened/start-instance.mjs --dry-run
node --test test/pal-hardening.test.js test/engine-integration.test.js test/codex-runner.test.js
node --test test/codex-mxc.test.js test/codex-client-isolation.test.js
node --test
```

Avant activation : tous les critères ci-dessus démontrés, preuves datées et versionnées, propriétaire approuvant une phase distincte. Le gate actuel doit rester inconditionnellement fermé ; aucune mission réelle n'est proposée à lancer dans cet état. Prochaine étape immédiate : revue des snippets inactifs, puis éventuelle autorisation **séparée** d'installation du hook projet. Les routes API, shell direct et CLI autonomes demandent un périmètre de protection distinct.
