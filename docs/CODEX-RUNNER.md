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

Les tentatives enregistrées, y compris les refus de capacité après démarrage de la trace, comptent. Le compteur est reconstruit depuis les exécutions persistantes du même appareil ; il ne repart pas à zéro au redémarrage. Les fenêtres de quota de l'abonnement ne sont pas lues par le runner. L'étude complémentaire ci-dessous identifie une méthode officielle app-server, non intégrée et non interrogée sur ce PC. L'interface conserve **quota inconnu**.

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

Les tests historiques `codex-runner.test.js` utilisent uniquement un script Node et un shim `.cmd` temporaires, sans vrai CLI. Succès, lignes invalides, fragmentation, auth/quota absents, CLI absent, capacité manquante, sortie énorme, timeout, annulation et descendant de processus sont simulés. La nouvelle suite `codex-mxc.test.js` utilise le vrai CLI Windows et un serveur loopback fictif, sans réseau externe ni modèle ; voir la phase de preuve ci-dessous.


## Étude complémentaire et décision sur l’essai réel — 22 novembre 2026

### Observations locales, sans modèle

Branche `codex-runner`, arbre initial propre ; Node `v24.13.1`, CLI `codex-cli 0.164.0`, Windows 11 Professionnel `10.0.26300` (build 26300). Les aides de `exec`, `app-server` et `sandbox` ont été exécutées, ainsi que `features list`. Aucun contenu du CODEX_HOME existant ni identifiant n’a été ouvert, copié ou journalisé par l’étude. L’abonnement connecté est une information du propriétaire, pas une vérification de compte effectuée ici.

Le shim npm est résolu par `resolveCodex` vers le processus :

```text
C:\Program Files\nodejs\node.exe
%USERPROFILE%\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js
```

Arguments successifs : `--version`, `--help`, `exec --help`, `app-server --help`, `sandbox --help`. Un essai de `--ignore-user-config --ignore-rules features list` est rejeté par le parseur (code 2) : ces options sont propres à `exec`, pas globales. La sonde `features list` utilise ensuite un CODEX_HOME temporaire neuf, sans authentification.

Toutes les sondes démarrent avec `shell:false`, timeout 15 s et sortie bornée (au plus 200 000 octets), dans un dossier créé sous `C:\Windows\Temp`, hors dépôt et dossiers personnels. Variables transmises, par nom seulement : `SystemRoot`, `WINDIR`, `TEMP`, `TMP`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` ; `CODEX_HOME` est ajouté pour les sondes features/MXC et désigne uniquement leur dossier neuf. Pas de PATH, proxy, options Node ou clé API hérités. Dossiers vides avant/après les sondes, puis supprimés. Le CLI avertit qu’il refuse de créer ses alias auxiliaires dans ce CODEX_HOME temporaire ; les sondes aboutissent néanmoins.

`features list` constate `hooks`, `plugins`, `shell_tool`, `unified_exec`, `skill_search`, `skill_mcp_dependency_install`, `multi_agent` et `view_image` actifs par défaut. Avec les huit `--disable` correspondants, tous passent à `false` **sauf `unified_exec`, qui reste `true`**. Ce constat ne démontre ni une exécution effective de commande, ni sa désactivation. `skip_host_skill_discovery` est « under development », faux ; les anciens flags `experimental_windows_sandbox` et `elevated_windows_sandbox` sont « removed ». Il ne faut pas déduire l’état du sandbox de ces anciens flags.

Test matériel sans modèle, arguments exacts après le point d’entrée Node :

```text
-c windows.sandbox="mxc" sandbox --permission-profile :read-only -- C:\WINDOWS\System32\cmd.exe /d /c "echo MXC_OK"
```

Cwd : `C:\Windows\Temp\archipel-mxc-Mf4qYb`, créé vide et supprimé après vérification. Sortie `MXC_OK`, code 0, aucun fichier ajouté. **MXC peut démarrer une commande avec ce profil sur ce PC.** Ce test ne tente ni lecture interdite, ni écriture, ni connexion réseau ; il ne prouve pas leur blocage. Aucun setup administrateur, compte Windows, règle pare-feu ou configuration persistante n’a été changé par nos commandes. La commande `cmd.exe` est ici une sonde explicite, pas un shell utilisé pour transporter un prompt.

### Documentation officielle et portée des garanties

Sources consultées le 22 novembre 2026 (les anciens liens developers.openai.com redirigent vers Learn) :

- [Sandbox et approbations](https://learn.chatgpt.com/docs/agent-approvals-security) : les restrictions concernent les commandes générées par le modèle. `never` interdit les demandes interactives, pas toutes les commandes. Le réseau des commandes et les connexions du client (modèle/authentification), MCP, apps, navigateur et web search sont des surfaces distinctes.
- [Permissions](https://learn.chatgpt.com/docs/permissions) : `read-only` restreint les écritures des commandes ; `workspace-write` permet les écritures du workspace et temporaires ; `danger-full-access` retire ces restrictions. Un cwd vide ne constitue pas une frontière de lecture. Les profils nommés permettent des restrictions supplémentaires, dont l’application dépend de la plateforme.
- [Windows](https://learn.chatgpt.com/docs/windows/windows-sandbox) : MXC est recommandé et utilise une isolation native des processus. Le mode legacy `elevated` utilise utilisateurs restreints et pare-feu ; `unelevated` utilise un jeton restreint et des contrôles réseau plus faibles, sans refus de lecture. Préférer MXC autorise un repli ; sa sélection explicite échoue s’il est indisponible. La documentation actuelle ne qualifie pas globalement le sandbox Windows d’expérimental ; l’aide locale qualifie encore app-server d’expérimental. Ne pas confondre ces statuts.
- [Configuration](https://learn.chatgpt.com/docs/config-file/config-reference) : `forced_login_method="chatgpt"`, `web_search="disabled"`, `features.shell_tool=false` et les réglages skills sont documentés. `skills.bundled.enabled=false` vise les skills embarqués ; `skills.include_instructions=false` vise leurs instructions automatiques ; `skills.config` cible des noms/chemins. Ce ne sont pas des preuves d’absence universelle de découverte. MCP possède `mcp_servers.<id>.enabled=false`, plugins et hooks leurs réglages. Aucun `tools.*=false` universel établi ici. Une surcharge TOML acceptée n’est pas une preuve de contrôle effectif ni de remplacement intégral d’une table fusionnée. `--ignore-user-config` ne promet que l’exclusion de config.toml utilisateur, et `--ignore-rules` celle des execpolicy `.rules`, pas de tous les AGENTS.md, skills ou hooks gérés. `project_doc_max_bytes=0` ne prouve pas cette absence globale. L’authentification ChatGPT peut donc être exigée par configuration documentée, mais n’a pas été validée localement avec un compte.
- [App-server](https://learn.chatgpt.com/docs/app-server) : protocole bidirectionnel JSON-RPC, threads, tours, annulation et demandes d’approbation, contre JSONL unidirectionnel pour un travail ponctuel avec `exec --json`. `sandboxPolicy.readOnly.access` vaut par défaut `fullAccess` et peut restreindre les racines lisibles. Ce transport n’isole pas à lui seul le serveur. `account/rateLimits/read` est documenté pour les fenêtres ChatGPT : existence officielle vérifiée, stabilité et compatibilité locale non établies ; aucun appel effectué. Le quota produit reste inconnu.

### Décision avant appel de modèle

**Essai réel non lancé : zéro exécution du modèle et zéro relance.** Aucun événement JSON de modèle, usage, durée de modèle ou outil invoqué par un modèle à rapporter ; ces données sont non applicables, jamais des mesures égales à zéro.

Les préconditions manquantes sont l’absence démontrée de tous les outils, MCP/skills/plugins/hooks et instructions locales, et une frontière de lecture/écriture/réseau couvrant les surfaces pertinentes. MXC est disponible, mais la sonde ne certifie pas une isolation du client complet : le CLI doit encore accéder à son authentification et peut avoir des écritures de fonctionnement malgré `--ephemeral`. Les fichiers hors cwd restent potentiellement lisibles sous le simple profil read-only ; les connexions modèle/authentification restent nécessaires. Le prompt « aucun outil » ne constitue pas un contrôle technique.

Déduction de sécurité : si l’exigence porte sur tout le processus, il faut une frontière Windows supplémentaire effectivement testée, avec accès aux seules ressources nécessaires et authentification non exposée aux outils. Un niveau d’intégrité bas ou un Job Object seul ne démontre pas cette politique de lecture et réseau. Aucun AppContainer, compte dédié ou Job Object enveloppant le client n’a été provisionné/validé ici. MXC pour les seules commandes ne suffit pas à établir cette garantie.

Le détecteur et son refus fermé restent inchangés. Son motif d’authentification signifie désormais « non validée dans un profil exécutable », pas « aucune option officielle n’existe ». Aucun accès direct au transport ne contourne ce refus. Activation pour une mission textuelle simple : **non dans l’état présent**, même si une future réponse OK réussissait. Avant une proposition d’activation progressive : prouver les surfaces désactivées avant le tour, tester les refus de lecture/écriture/réseau avec des données synthétiques, puis encadrer un seul appel avec instantanés et suivi des descendants. Les instantanés spécifiques avant/après modèle sont sans objet puisque l’appel n’a pas été autorisé par les préconditions ; les sondes temporaires ont leurs propres vérifications ci-dessus. Les processus Codex déjà présents appartiennent à la session hôte et ne doivent pas être arrêtés.

## Phase de preuve MXC, sans modèle — 22 novembre 2026

**Verdict : insuffisant pour activer le runner ; détecteur inchangé.** Les frontières testées des commandes sont effectives avec un profil durci. Elles ne confinent pas le client Codex complet et ne démontrent pas la disparition de tous ses outils et chargements locaux. Aucun tour `exec`, appel modèle ou tentative d’authentification n’a été lancé. L’absence d’authentification ne constitue pas ici une preuve d’absence de requête réseau : nous n’avons pas tenté un tour pour le vérifier.

Reproduction : `node --test test/codex-mxc.test.js`, puis `node --test`. La suite est automatique sur Windows avec CLI présent ; elle indique un skip explicite si Windows/MXC/CLI est indisponible ou MXC refusé. Un timeout ou un échec d’assertion ne devient pas un skip. Aucun repli legacy. Les diagnostics `MXC_PROOF` enregistrent les arguments exacts en tableau, cwd, noms des variables, résultats attendus/observés, durées et inventaires des fichiers. Le relevé de cette exécution est conservé dans [CODEX-MXC-PROOF.json](CODEX-MXC-PROOF.json). Ce relevé est une observation locale datée, pas un profil autorisé.

Toutes les cibles de lecture/écriture sont fictives sous `C:\Windows\Temp\archipel-mxc-proof-*`, hors dépôt et dossiers personnels. Chaque dossier est supprimé après inventaire ; aucune authentification existante n’est consultée. Le shim npm est résolu sans shell vers Node + `@openai/codex/bin/codex.js`. Variables transmises aux sondes, noms uniquement : `SystemRoot`, `WINDIR`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `CODEX_HOME`, `TEMP`, `TMP`. Pas de PATH, clé API, proxy ou NODE_OPTIONS hérités.

Forme des commandes réellement exécutées :

```text
<node.exe> <codex.js> -c windows.sandbox="mxc" sandbox --permission-profile <profil> -- <exécutable> <arguments>
```

Les profils `probe_read` et `probe_write` utilisent la syntaxe documentée `[permissions.<nom>.filesystem]` : `:root="deny"`, `:minimal="read"`, répertoire de Node en lecture, cwd en lecture ou écriture, et **deny explicite sur les dossiers frères outside et home** ; `network.enabled=false`. `default_permissions="probe_read"` est nécessaire aux commandes d’inventaire lorsque le fichier contient ces profils. La variante d’écriture teste une permission workspace limitée au cwd ; elle n’est jamais proposée pour une mission textuelle. Aucun profil dangereux n’est sélectionné.

| Capacité | Attendu | Observé sur le vrai CLI 0.164.0 | Restriction effective | Limites |
| --- | --- | --- | --- | --- |
| Lecture du piège frère, `:read-only` | Refus souhaité | Lecture réussie, comme faux config et skill | Lecture seule n’est pas une frontière de lecture | Échec de l’exigence de confinement au cwd |
| Lecture, profils durcis | Refus ; témoin intérieur lisible | `EPERM` sur piège, config, faux ~/.codex et skill ; témoin lu | Deny exact effectif sur les cibles testées | Ne démontre pas l’inaccessibilité de tout le disque |
| Écriture cwd, `:read-only` et `probe_read` | Refus | `EPERM` | Écriture bloquée | Les écritures internes du client sont une autre surface |
| Écriture extérieure, trois profils | Refus | `EPERM` | Écriture bloquée | Cibles temporaires synthétiques seulement |
| Écriture autorisée, `probe_write` | Succès | Fichier FICTIF créé dans cwd | Grant exact appliqué | Profil de sonde, non activé dans le produit |
| TCP 127.0.0.1, port éphémère | Refus | `EACCES`, zéro connexion reçue pour chaque profil | Loopback bloqué dans ces profils sans réseau | Témoin positif hors sandbox : une connexion ; pas de test Internet/DNS/UDP |
| Enfants cmd, PowerShell, Node | Héritage des refus | Tous lisent le témoin ; piège lisible en baseline, refusé avec deny exact | Frontière de lecture héritée dans ces trois cas | Pas un inventaire de tous les exécutables/IPC possibles |
| curl | Lancement observé | `curl --version`, code 0 | Exécutable disponible | Ne démontre pas une interdiction universelle des outils |
| Inventaire MCP par le client | Voir faux MCP sans le lancer | Visible ; override enabled=false reflété ; aucun marqueur de lancement | Désactivation du seul serveur nommé constatée | Config globale ignorée n’équivaut pas à désactiver toutes les sources |
| Features désactivées | Toutes false | unified_exec reste true ; les sept autres false | Sept désactivations affichées | Aucun tour : efficacité runtime et découverte des skills non prouvées |
| exec ignore-user-config / ignore-rules et overrides | Options acceptées sans tour | Aide code 0 | Acceptation syntaxique seulement | --help ne prouve pas le chargement effectif ni la suppression des outils |
| Arrêt arbre | Aucun descendant résiduel | Timeout produit, quatre PID témoins arrêtés ; inventaires CIM dédiés vides avant/après | killTree privé exercé via codexTransport | Enveloppe fictive ; vraie commande longue sous MXC ; aucun exec modèle |
| Client complet | Même confinement que les commandes | mcp list lit le home interdit aux commandes ; fichiers auxiliaires créés dans home/tmp | Le client et son lanceur restent hors frontière des outils | Aucun confinement global démontré ; pas de capture exhaustive des accès |

Une première sonde avec seulement `:root=deny`, `:minimal=read` et les grants de runtime/cwd laissait lire les pièges sous Windows Temp. Les deny exacts rendent les refus observables ; **ne pas présenter :minimal comme une liste blanche limitée au cwd**, ni étendre ces refus ciblés aux fichiers personnels non testés. Une première sonde PowerShell utilisant `[IO.File]` était bloquée par ConstrainedLanguage ; elle a été remplacée par `Get-Content` avec témoin positif, pour ne pas confondre restriction du langage et refus de fichier.

L’aide expose également les options de sandbox-state, racine lisible additionnelle et désactivation réseau. Elles demandent un état opaque produit par `codex/sandbox-state` ; aucun état inventé n’est utilisé. Les profils documentés suffisent aux sondes ici. Les sorties d’aide ne sont pas des preuves d’application.

**Distinction réel/fictif :** frontières de fichiers, sockets et petits-fils testées sur le vrai Codex et MXC. Serveur TCP, fichiers, skill et MCP sont fictifs. Le test d’interruption passe par une enveloppe Node fictive qui ignore les arguments exec du transport et lance exclusivement `codex sandbox` ; la fonction d’arrêt de production reste celle de `src/codex-runner.js`. Les tests historiques de protocole/auth/quota restent entièrement simulés. Les inventaires sont limités aux dossiers et processus dédiés ; aucun contenu personnel, auth.json ou jeton n’est collecté.

Le client n’est pas enveloppé dans MXC : son accès à la configuration et ses écritures auxiliaires sont observés malgré le refus de ces mêmes chemins dans la commande. Un lancement `exec` sans authentification n’ajouterait pas une preuve suffisante et pourrait déjà tenter une connexion ; il n’a pas été exécuté. Aucun netstat global contenant les connexions de la session hôte n’est collecté. L’inventaire de fichiers ne couvre pas toutes les lectures, et l’absence d’un socket dans un instantané ne prouverait pas l’absence de trafic.

**Désactivation shell_tool + MXC + cwd vide : insuffisant dans l’état vérifié.** unified_exec reste déclaré actif ; absence universelle de MCP/skills/hooks/plugins, instructions et accès du client non démontrée. Aucune mission de validation proposée ou lancée, aucun profil exécutable ajouté, aucun changement de sécurité Windows global demandé. Les preuves ciblées renforcent la connaissance du sandbox sans lever le refus fermé.

Vérification de cette phase : ciblés runner + MXC **24/24**, puis suite complète **496/496**, 0 échec, 0 skip, **23,39 s**. Les six nouveaux cas (parent compris) utilisent le vrai MXC ; aucun test modèle. Aucun fichier de production modifié, aucun commit/push/fusion.

## Option 2 : client complet dans MXC — 22 novembre 2026

**Verdict : insuffisant ; refus fermé de production inchangé.** Cette phase enveloppe réellement le binaire natif Codex dans MXC. Elle démontre des refus de fichiers par le client complet, mais ne démontre pas un transport réseau limité au seul fournisseur, un catalogue sans outils ni le rejet d'appels d'outils forcés. Aucun appel OpenAI, aucune authentification réelle, aucune mission de validation. Le transport de production et le détecteur ne sont pas modifiés.

Reproduction : `node --test test/codex-client-isolation.test.js`. Les commandes exactes, cwd, variables transmises par nom, configuration synthétique, événements et inventaires sont enregistrés dans `CODEX-MXC-PROOF.json`, sous `clientIsolation`. Les diagnostics masquent les chemins personnels par `%USERPROFILE%`. Les fichiers de schéma générés sont comptés et seuls les schémas pertinents sont conservés ; ils sont exclus des inventaires répétés sous `home/schema`. Tous les dossiers de sonde sont créés sous Windows Temp et supprimés après vérification. Aucun fichier personnel ou identifiant existant n'est ouvert par les sondes.

### Frontière et profils réellement exercés

Le profil `narrow` utilise `:root="deny"`, **sans `:minimal`**, avec lecture de System32, du répertoire Node, du seul paquet d'installation Codex et du cwd de test ; seule l'arborescence HOME temporaire dédiée est writable. Aucun deny ciblant le piège n'est nécessaire. Le profil `localproxy` reprend ces racines, active le réseau, déclare `features.network_proxy=true`, un `proxy_url` local et le domaine autorisé `127.0.0.1`. Seules des commandes Node synthétiques sont lancées avec ce profil réseau ; **le client exec n'y est jamais lancé** après l'échec de la sonde préalable.

Le lancement du shim Node depuis un chemin de script échoue dans la liste blanche étroite : Node tente `lstat C:\`. La sonde n'élargit pas l'accès à la racine du disque ; elle exécute directement le `codex.exe` du même paquet installé. C'est une invocation équivalente du vrai client, avec le lanceur extérieur Node hors MXC et le client intérieur natif dans MXC. Seul ce dernier et son arbre constituent la frontière prouvée. `windows.sandbox="mxc"` est sélectionné explicitement aux deux niveaux. Sans cette sélection intérieure, un premier `thread/start` avait refusé de démarrer son wrapper unelevated incapable d'appliquer les restrictions : aucun repli moins strict n'a été autorisé.

```text
<node.exe> <codex.js> -c windows.sandbox="mxc" sandbox -P narrow --
  <codex.exe> exec --json --ignore-user-config --ignore-rules
  --skip-git-repo-check --ephemeral --sandbox read-only
  -c windows.sandbox="mxc" <overrides du fournisseur fictif et désactivations>
  "Sonde fictive, réponds OK."
```

Le fournisseur nommé `archipel_fictif` utilise `wire_api="responses"`, `base_url="http://127.0.0.1:<port éphémère>/v1"`, `requires_openai_auth=false` et `env_key="ARCHIPEL_FAKE_AUTH"`. Cette variable contient une valeur synthétique sans validité ; aucune clé API ou authentification ChatGPT n'est utilisée. Le provider local n'est pas un repli de production. Les réglages de test qui autorisent son auth fictive ne sont pas proposés pour une mission réelle. Les noms de variables transmis sont `SystemRoot`, `WINDIR`, `HOME`, `USERPROFILE`, `CODEX_HOME`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, `ARCHIPEL_FAKE_AUTH`. Aucun PATH, proxy hérité, secret ou NODE_OPTIONS. Analytics et feedback désactivés.

### Résultats : commandes synthétiques, vrai client et témoins locaux

| Capacité | Attendu | Observé | Restriction effective | Limites |
| --- | --- | --- | --- | --- |
| Racines explicites sans `:minimal` | Lire témoin, refuser piège frère | Témoin lu ; piège `EPERM`, sans deny par dossier | Liste de grants applicable sur ces cibles Windows | Pas d'audit exhaustif des accès aux racines runtime autorisées |
| Réseau désactivé | Refus loopback | `EACCES` pour Node ; fournisseur non joint par le vrai exec | Frontière réseau du client actif sous MXC | Fournisseur local également inaccessible |
| Réseau activé + proxy/domaines | Uniquement endpoint local | Connexions directes réussies vers autre port et **127.0.0.2 non autorisé**, confirmées par les serveurs | Cette invocation `sandbox` ne démontre pas l'application du proxy | Réseau externe non tenté ; ne pas activer exec dans ce profil |
| Fournisseur fictif Responses | Observer la requête et les outils | Pas de requête reçue sous réseau désactivé | Le client est bloqué avant toute réponse fournisseur | Catalogue, SSE et appels forcés **non testés** ; skip explicite |
| Vrai `exec --json` enveloppé | Démarrer sans OpenAI | `thread.started`, `turn.started`, erreurs de connexion locale ; arrêt borné | Le vrai client fonctionne dans MXC avec des écritures de cache dédiées | Aucun résultat ni usage modèle ; messages de métadonnées fallback ne sont pas un repli fournisseur |
| Arrêt de ce vrai exec | Aucun processus résiduel | PID du lanceur et descendants observés arrêtés ; inventaire après vide | `taskkill /T /F` borné sur l'arbre de sonde | Instantanés CIM/netstat, pas trace exhaustive des processus ou sockets transitoires |
| App-server stdio | Initialiser et créer thread sans tour | `initialize` et `thread/start` réussis ; profil `narrow`, `approvalPolicy=never`, `dynamicTools=[]` | Contrôle de thread compatible localement | Liste dynamique vide ne supprime pas les outils intégrés ; aucun `turn/start` |
| `readOnly.access` et racines restreintes | Compatibilité avec la documentation actuelle | Schéma généré 0.164.0 : `readOnly` contient `networkAccess`, **aucun champ `access`** | Profils nommés utilisables comme observé, pas cette forme de politique | Compatibilité du champ non établie ; ne pas supposer qu'un champ supplémentaire accepté serait appliqué |
| Lectures par **le client app-server** | Témoin accessible, piège inaccessible | `fs/readFile` : témoin retourné ; piège erreur 5 | Refus du client complet, pas seulement d'une commande d'outil | Requêtes JSON-RPC initiées par le test, pas des appels d'outils émis par un modèle |
| Écritures par le client | Uniquement HOME temporaire | `fs/writeFile` autorisé dans HOME ; refus dans cwd et dossier frère | Frontière d'écriture vérifiée aux cibles synthétiques | HOME writable nécessaire au fonctionnement ; ni absence de toute écriture ni lecture seule globale |
| Instructions et MCP | Pas de chargement local | `instructionSources=[]` malgré faux AGENTS.md ; faux MCP désactivé sans marqueur d'exécution | Cas synthétiques ciblés seulement | Skill fictif et sources de plugins non validés au niveau d'une requête fournisseur |
| Découverte de skills | Aucune découverte utilisateur | Le client tente encore le vrai chemin utilisateur `.agents/skills` ; **accès refusé par MXC** | Pas de contenu personnel lu par cette tentative | HOME filtré et réglages skills ne prouvent pas l'absence de découverte |
| `codex/sandbox-state` | Obtenir état réutilisable | Méthode inconnue, erreur JSON-RPC `-32600` | Non disponible par cette interface app-server 0.164.0 | Ne pas fabriquer d'état opaque pour contourner le blocage réseau |
| Quotas | Compatibilité sans appel compte | Schéma local `GetAccountRateLimitsResponse` présent | Existence de la surface locale constatée | `account/rateLimits/read` jamais appelé, accès backend potentiellement requis ; quota toujours inconnu |
| Job Object, **processus Node fictifs** | Ressources bornées, arrêt à fermeture | Troisième association refusée, erreur 1816 ; deux processus actifs arrêtés à fermeture du job | Création suspendue, association avant reprise, kill-on-close ; limite de 2 processus | Pas de test d'imbrication avec tout l'arbre Codex/MXC |
| Limite mémoire du Job | Configuration acceptée | 1 Gio confirmé par `QueryInformationJobObject` | Limite de mémoire engagée du job configurée | Aucun stress mémoire ; pas de preuve empirique du seuil de refus |

Le serveur HTTP fictif n'effectue **aucun forwarding**, refuse les destinations et CONNECT non attendus, et n'écoute que sur loopback. Deux autres serveurs de contrôle témoignent des connexions directes ; les témoins positifs hors MXC vérifient qu'ils fonctionnent. Il n'a pas servi de réponse de modèle : l'échec du contrôle réseau interdit de lancer cette phase. Aucun essai de faux outil n'est compté comme réussi par absence de requête.

Le client exec maintient une attente/reconnexion malgré les deux compteurs de retries configurés à zéro ; le timeout d'arrêt est donc indispensable. Le budget d'exécution est 5 s, auquel s'ajoutent l'arrêt et les inventaires CIM/netstat. Les instantanés ne trouvent pas de socket TCP appartenant à l'arbre observé ; ils ne prouvent pas l'absence de toute tentative réseau, UDP ou socket fugace. Les commandes sans réseau restent sous MXC indépendamment de cette observation. Les fichiers SQLite, logs, identifiant d'installation et scripts auxiliaires apparus sont inventoriés dans le HOME synthétique. Leur contenu n'est pas collecté.

### Comparaison et décision

App-server donne un contrôle JSON-RPC plus fin qu'exec : création du thread sans tour, profil explicite et paramètres par tour. Les schémas expérimentaux générés localement exposent `dynamicTools` et `permissions`, mais **pas `sandboxPolicy.readOnly.access`** : leur variante `readOnly` ne contient que `type` et `networkAccess`. La documentation en ligne décrit ce contrôle de lecture ; sa compatibilité locale n'est donc pas établie et aucun champ supposé n'est utilisé. `dynamicTools=[]` signifie absence d'outils dynamiques fournis par l'hôte ; il ne démontre pas un catalogue total vide. Aucun appel de compte, login ou quota n'est fait. [Documentation app-server](https://learn.chatgpt.com/docs/app-server)

Les règles de domaines nécessitent un proxy actif ; activer le réseau seul ne suffit pas. Le résultat local distingue bien la possibilité de décrire une politique et son application à l'invocation utilisée. La documentation ne fournit pas ici une règle portable hôte **et port** satisfaisant le besoin. [Permissions](https://learn.chatgpt.com/docs/permissions)

La sonde `test/fixtures/codex-job-probe.ps1` utilise uniquement les API Win32 de processus et Job Object par `Add-Type`, sans installation, compte, ACL, stratégie, registre ni règle pare-feu. Une première variante avec `child_process.spawn` dans le job a échoué `spawn UNKNOWN` ; la preuve retenue associe deux processus distincts créés suspendus par l'hôte. Elle ne certifie donc pas l'héritage des enfants ou la compatibilité libuv/MXC. Les jobs complètent la gestion des ressources et la fermeture ; ils ne définissent pas les racines lisibles ou une politique réseau. [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

Un jeton restreint peut être créé sans nouveau compte mais ses SID/privilèges ne fournissent pas automatiquement la liste blanche de chemins et destinations demandée. Un niveau d'intégrité bas seul protège surtout les écritures vers des objets de niveau supérieur ; les étiquettes par défaut n'interdisent pas leurs lectures. Aucune couche de jeton supplémentaire n'est prétendue validée. [Restricted Tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens), [Mandatory Integrity Control](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)

Critères de suffisance : **1 non prouvé** (catalogue non capturé) ; **2 non prouvé** (aucune réponse forçant un outil reçue) ; **3 partiel** (fichiers et absence de réseau démontrés sur les cibles, pas de canal fournisseur utilisable et restreint) ; **4 non prouvé** (découverte skills toujours tentée, instructions sortantes non observées) ; **5 démontré sur l'arbre exec observé**, avec limites d'instantané explicites. Aucun « profil d'isolation vérifié » ajouté et aucune mission de validation proposée. Le blocage actuel est le canal réseau du client complet : il faut un endpoint utilisable avec refus des autres destinations effectivement prouvé avant de capturer le catalogue ou de forcer un outil.

Vérification finale : ciblés runner + MXC + client **32 tests, 31 réussis, 0 échec, 1 skip**, 19,62 s ; `node --test` complet **504 tests, 503 réussis, 0 échec, 1 skip**, 24,24 s. Le skip identifie la capture du catalogue et les outils forcés, jamais une réussite simulée. Les anciens 496 cas passent. Aucun changement dans `src/`, aucune activation, aucun commit/push/fusion ; CRLF et `git diff --check` vérifiés.
