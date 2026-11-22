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

## INSTALLATION DU HOOK (réglages locaux du projet)

Installé le 22/11/2026 dans `.claude/settings.json` **du projet** (branche `pal-hardening`) ; aucun réglage global (`~/.claude*`, Codex, PAL, Windows) modifié ; instance durcie (`.mcp.json`) **non installée**, aucun accord ni exception temporaire créé.

Diff exact (ajout seul, les sept refus `shopify theme …` d'origine sont intacts) :

```diff
       "Bash(shopify theme duplicate:*)"
     ]
-  }
+  },
+  "hooks": {
+    "PreToolUse": [
+      {
+        "matcher": "mcp__.*__clink",
+        "hooks": [
+          {
+            "type": "command",
+            "command": "node \"$CLAUDE_PROJECT_DIR/tools/pal-hardening/guard-clink.mjs\"",
+            "timeout": 5
+          }
+        ]
+      }
+    ]
+  }
 }
```

Écarts avec le snippet proposé : `$CLAUDE_PROJECT_DIR` remplace `<PROJET>` (réglage commité, valable sur chaque PC) ; **`onFailure` n'a pas été repris** : ce champ n'a pas pu être confirmé dans la documentation des hooks, donc la protection ne repose que sur le code de sortie 2 du script (voir risques).

### Preuve de chargement réel
- Dans la session Claude Code en cours, un appel `mcp__pal__clink` avec un `cli_name` inconnu (sans danger : PAL aurait seul rejeté) a été **intercepté par le hook** : message « PreToolUse:mcp__pal__clink hook error … Délégation PAL bloquée … Aucun CLI lancé ». Le hook est donc chargé et actif sans redémarrage.
- Aucun appel réel avec `cli_name=codex` n'a été fait : le chemin de code « non reconnu / codex » est le même ; il est couvert par les tests, exécutés **avec la commande exacte des réglages** (`bash -c` + `CLAUDE_PROJECT_DIR`), dont un faux Codex placé dans le PATH dont le compteur d'exécutions reste à zéro.

### Routes
Bloquées : `mcp__*__clink` avec Codex (toute casse, espaces, suffixes, rôles, `continuation_id`, fichiers), client inconnu, `cli_name` absent/non texte, entrée malformée, vide, trop volumineuse, JSON invalide.
Laissées accessibles (volontairement) : `clink` vers `claude`, `gemini`, `agy` ; tous les autres outils.
**Hors portée du hook, NON protégées** :
1. `chat`, `codereview`, `thinkdeep`, `consensus` (fournisseurs API, y compris un alias « codex ») ;
2. appels shell directs (`codex exec …` via Bash/PowerShell) ;
3. autres clients CLI : **Gemini lance `--yolo` et Claude `acceptEdits` : ce hook ne les rend PAS sûrs**, il les laisse simplement passer ;
4. un autre serveur MCP ou un script qui lance Codex sans passer par un outil `*clink` ; une exécution depuis un terminal ou un autre projet ;
5. les environnements où ce fichier de réglages n'est pas chargé (autre dossier de travail, réglages locaux/globaux qui désactiveraient les hooks).

### Risques résiduels de l'installation
- **Échec du hook** : selon la documentation de Claude Code, seul le code 2 bloque ; si `node` est introuvable ou plante avant d'écrire sa sortie, l'erreur peut être non bloquante et `clink` passerait. Le script refuse (exit 2) sur toute erreur qu'il détecte lui-même, mais pas sur un échec de lancement. À surveiller (mêmes conditions sur chaque PC).
- Une allowlist (`claude`, `gemini`, `agy`) : un client ajouté plus tard à PAL est refusé par défaut (fermé), pas autorisé.
- Les réglages du projet sont modifiables par quiconque modifie le dépôt ; ce n'est pas une barrière contre un attaquant local.
- Les tests unitaires ne prouvent pas, seuls, l'activation : la preuve de chargement ci-dessus est ponctuelle (cette session).

## PASSE FINALE (22/11/2026) : fail-closed, autres routes, sonde du vrai client

**Verdict : le chantier n'est PAS terminé.** Les protections de routage sont renforcées ; l'intégration de Codex reste refusée : plusieurs critères d'isolation sont démontrés comme NON satisfaits (voir ci-dessous).

### Versions et organisation
- Codex CLI installé **0.164.0** (dernier publié : 0.171.0, non installé : installation système interdite). Aucune commande ne liste les modèles disponibles : le nom « GPT-6.2 Astra » n'a pas pu être vérifié hors ligne ; le client annonce par défaut le modèle `gpt-6.1-sol` (observé dans une requête vers un faux fournisseur). Aucun identifiant de modèle n'a été imposé.
- Claude Code 2.1.101 ; Claude Opus 5.5 / Sonnet 5.5 disponibles. Codex n'a **pas** été utilisé pour ces travaux : sa seule voie de délégation (clink) lance `--dangerously-bypass-approvals-and-sandbox` et est désormais bloquée par le hook ; un `codex exec` direct enverrait du contexte à OpenAI avec un client non confiné. Travaux faits par Claude Code, revue indépendante par Claude Opus.

### 1. Fail-open éliminé
Claude Code ne bloque que sur le code de sortie 2 ; un échec de lancement (node introuvable, script corrompu) donne un code non bloquant (127, 1). La commande installée est désormais `node "$CLAUDE_PROJECT_DIR/tools/pal-hardening/guard-clink.mjs" || exit 2`. Preuves : `PATH` vide → 2 (sans le garde-fou : 127, test témoin) ; script corrompu → 2. Un plantage du script en cours de route a été observé en direct pendant ce travail (erreur de syntaxe) : le hook a alors bloqué TOUS les appels clink, preuve de fermeture. Reste : un shell de hooks absent ou une désactivation des hooks côté Claude Code échappent à cette protection.

### 2. Autres routes (après revue indépendante Claude Opus)
Réglages du projet : un hook unique (matcher `mcp__.*pal.*__.*|mcp__.*terminal.*|Bash|PowerShell`, timeout 30 s, `|| exit 2`) exécute le garde ; `permissions.deny` ajoute `Bash(codex:*)`, `.cmd`, `.exe`, `npx`/`pnpm dlx`/`bunx`/`yarn dlx`/`npm exec` (@openai/codex), `cmd /c codex`, `env codex`.
- **clink** : liste d'autorisation `claude`, `gemini`, `agy` ; Codex, inconnu, ambigu = refus.
- **Routes API PAL** (toutes les routes `mcp__*pal*__*` sauf `listmodels`, `version`, `apilookup`) : **liste d'autorisation de modèles non-OpenAI** (préfixes `gemini`, `flash`, `pro`, `grok`, `claude`/`sonnet`/`opus`/`haiku`, `google/`, `anthropic/`, `meta-llama/`, `deepseek`, `qwen`, `mistral`…) ; `auto`, modèle absent, alias OpenAI (`o3mini`, `mini`, `nano`, `4o`…), noms inconnus, caractères invisibles, type inattendu = refus ; `consensus` : chaque entrée de `models[]`. (La première version utilisait une liste de refus : la revue a montré qu'elle laissait passer des alias ; remplacée.) **Conséquence** : les routes API de PAL exigent maintenant un modèle explicite non-OpenAI.
- **Shell** (Bash, PowerShell, terminal MCP) : commande lançant le CLI Codex (paquet `@openai/codex`, `codex.js|cmd|exe`, ou `codex` en position de commande, y compris après `cmd /c`, `bash -c`, `env`, `npx`…) = refus ; un simple message de commit contenant « Codex » passe.
- **Fail-closed** : `|| exit 2` (échec de lancement = blocage), minuterie interne 3 s (stdin jamais fermé = refus), timeout du hook 30 s.
**Toujours hors de portée** : un serveur MCP ou script qui appelle Codex sans passer par ces outils (`npm run <script>`, `node -e` important `src/codex-runner.js`, commande construite dynamiquement, retrait de l'environnement) ; une exécution hors de ce projet ou hors Claude Code ; `disableAllHooks` dans des réglages utilisateur/locaux ; un `gemini.json` utilisateur redirigé vers Codex (l'autorisation repose sur le nom du client, pas sur sa commande) ; Gemini `--yolo` et Claude `acceptEdits` (autorisés, **NON sécurisés**). La seule parade complète est de retirer la clé OpenAI de l'environnement PAL et le CLI Codex du PATH de cet utilisateur : **changements globaux non faits ici**.
**Shell du hook** : constaté en direct que le hook s'exécute dans un shell de type bash (`$CLAUDE_PROJECT_DIR` et `|| exit 2` fonctionnent) ; sous un autre shell (PowerShell 5.1) `||` serait une erreur de syntaxe : à revérifier si Claude Code change de shell.

### 3. Isolation réseau : non démontrée (blocage confirmé)
Sous MXC avec réseau désactivé, même le loopback est refusé ; réseau activé = tout-ou-rien (d'autres ports et 127.0.0.2 joignables). Pas de filtrage par hôte/port côté noyau accessible sans modifier la sécurité globale de Windows (pare-feu par application, compte dédié : interdits). Un proxy applicatif ne prouve rien si le client peut le contourner. Conclusion : le client ne peut pas être à la fois confiné par MXC et joindre un fournisseur. **Échec du critère réseau.**

### 4. Sonde du vrai client contre un faux fournisseur (sans OpenAI)
Méthode : vrai `codex` (non confiné par MXC), fournisseur factice sur 127.0.0.1, clé factice, `CODEX_HOME` temporaire, environnement filtré, aucun compte (`test/codex-client-catalog.test.js`, opt-in `ARCHIPEL_CODEX_PROBES=1`). Aucune connexion non locale observée par instantanés `netstat` (observation, pas une garantie).

| Critère | Observé (0.164.0) | Statut |
|---|---|---|
| Catalogue d'outils vide | **Non** : `exec` (orchestrateur JavaScript), `wait`, `request_user_input(_async)`, `sleep`, `clock`, outils multi-agents (`spawn_agent`, `send_message`…) ; `-c features.*=false` retire `sleep`/`clock` et l'outil shell mais `exec` et le multi-agent restent annoncés ; `--disable` ne change pas le catalogue annoncé | **Échec** |
| Appel forcé | Un `exec_command` d'écriture forcé hors du cwd est rejeté (`read-only`, politique) : fichier piège non créé ; avec `features.shell_tool=false` : « exec_command is not a function » | Partiel (une observation, pas une preuve de sandbox) |
| Skills utilisateur | **47 des 55 skills du VRAI profil utilisateur** (noms + descriptions) sont envoyés au modèle ; leur racine est résolue depuis le profil Windows réel, **indépendamment de HOME/USERPROFILE** ; `skip_host_skill_discovery` sans effet ; seul MXC les rend illisibles (mais coupe le réseau) | **Échec** |
| Configuration utilisateur | Avec `--ignore-user-config`, le MCP déclaré dans `config.toml` n'est pas lancé ; en revanche `AGENTS.md` et les skills de `CODEX_HOME`, et `AGENTS.md` du dossier de travail, SONT chargés (donc `CODEX_HOME` et cwd doivent être vierges) | Partiel |
| Réseau | voir §3 | **Échec** |

### Clé OpenAI de PAL : neutralisable sans la supprimer (vérifié, NON appliqué)
Décision du propriétaire : conserver Codex CLI installé et le blocage PAL ; ne pas retirer la clé globalement ; chercher à l'exclure de l'environnement **PAL** seulement.
- **Faits (code de PAL, lecture seule ; `.env` réel jamais ouvert)** : `configure_providers` ignore une clé égale à `your_openai_api_key_here` (server.py ~l.420) ; PAL charge son `.env` avec `override=False` (utils/env.py) : **une variable d'environnement du processus l'emporte** sauf si `PAL_MCP_FORCE_ENV_OVERRIDE=true` est écrit dans le `.env` (à vérifier par le propriétaire : sinon la neutralisation serait annulée). `OPENAI_ALLOWED_MODELS`, `OPENROUTER_ALLOWED_MODELS` permettent aussi de restreindre les modèles.
- **Vérifié** (`tools/pal-hardening/check-env-precedence.py`, `.env` FICTIF temporaire, Python du venv PAL) : la valeur « absente » posée dans l'environnement du processus neutralise `OPENAI_API_KEY` et `AZURE_OPENAI_API_KEY`, `GEMINI_API_KEY` reste lue depuis le `.env`, et un override forcé inverserait le résultat (test `pal-hardening.test.js`).
- **Autres usages de la clé** : aucune variable `OPENAI_*` dans l'environnement de cette session ; Codex CLI utilise la connexion ChatGPT, pas cette clé ; seuls les modèles OpenAI **via PAL** seraient perdus. La clé OpenRouter reste active (accès à des modèles OpenAI par OpenRouter : couvert seulement par le garde et, au besoin, `OPENROUTER_ALLOWED_MODELS`).
- **Comment l'appliquer sans toucher à la configuration globale** (proposition `tools/pal-hardening/mcp-pal-no-openai.proposed.json`, **non installée**) : une entrée « pal » dans un `.mcp.json` du projet, dont le bloc `env` pose la valeur « absente ». Les déclarations utilisateur (`.claude.json`) restent intactes. **À valider avant usage** : (1) qu'une entrée de projet de même nom masque bien celle de l'utilisateur dans ce seul projet ; (2) l'approbation du serveur de projet par le propriétaire ; (3) que `PAL_MCP_FORCE_ENV_OVERRIDE` n'est pas actif. Tant que ce n'est pas installé, **la clé reste active dans PAL** (le hook reste la seule protection).

### Critères manquants avant toute activation
Canal fournisseur unique imposé par le noyau ; catalogue d'outils vide ou inoffensif prouvé ; aucune lecture du profil réel (skills) hors MXC ; authentification légitime d'un courtier ; arrêt robuste de l'arbre ; revue indépendante finale. **Sans eux, refus fermé conservé, aucune activation.**

### Réexamen
Relancer `ARCHIPEL_CODEX_PROBES=1 node --test test/codex-client-catalog.test.js` à chaque nouvelle version du CLI : un test qui échoue signale un changement à analyser (par ex. un catalogue réduit ou des skills non chargés), pas un bug.

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
