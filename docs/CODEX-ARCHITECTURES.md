# Claude Code ⇄ Codex via PAL : audit et architectures

22/11/2026 — codex-runner/a2c66d6, arbre initial propre. Phases 1–3. **Aucune architecture activable conforme ; refus fermé.** Seule cette synthèse ajoutée, aucune activation. Démontré=observation ciblée ; Partiel=couverture limitée ; Non démontré=preuve absente ; Échec=attendu contredit.

## 1. Audit

Réutilisables : `src/codex-runner.js` (shim sans shell, PII/secrets, env filtré, JSONL borné, erreurs, annulation/timeout/taskkill) et `engine-provider.js` (texte/usage, concurrence=1, coût inconnu, aucun repli). safe:false/runCodex fermé. codexTransport non autorisé ; réaction après événement outil trop tardive. CODEX_HOME existant conservé pour auth.

Tests lus : codex-runner=faux CLI ; codex-mxc=vrai sandbox/témoins fictifs ; codex-client-isolation=vrai client/RPC et Job fictif. Docs CODEX-RUNNER.md/CODEX-MXC-PROOF.json : historique 503/504, un skip, non relancé.

### PAL réel

PAL : `%USERPROFILE%/tools/pal-mcp-server`, Python `.pal_venv/Scripts/python.exe` observé ; .claude.json déclare ce Python + server.py sans env explicite. Audit disque, aucun outil PAL callable ni registre vivant interrogé.

`conf/cli_clients/codex.json` + `clink/constants.py` construisent :

```text
codex exec --json --dangerously-bypass-approvals-and-sandbox --enable web_search_request
```

**Échec pour l’analyse sensible** : sandbox/confirmations supprimés ; accès PC/réseau selon droits Windows hérités, sans élévation. Flag web demandé, effet runtime non testé. Commande dangereuse jamais exécutée ici.

Rôles default/planner/codereviewer : systemprompts/clink/{default,default_planner,codex_codereviewer}.txt ; role_args vides. base.py copie os.environ, hérite cwd, tue seulement le parent ; CodexAgent récupère parfois un texte après exit non nul. clink.py ajoute continuation/fichiers : filtrer avant composition et mémoire.

Variables présentes ici et déclarées dans PAL/.env, noms seuls : OPENAI_API_KEY, AZURE_OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, DIAL_API_KEY, OPENROUTER_API_KEY. Valeurs jamais affichées ; validité/env serveur inconnus. DEFAULT_MODEL=auto ; outils désactivés : analyze,refactor,testgen,secaudit,docgen,tracer.

| Outils PAL | Chemin constaté dans les sources |
|---|---|
| clink | Sous-processus CLI ; hérite des droits/env ci-dessus |
| chat, codereview, thinkdeep | SimpleTool/workflow → provider.generate_content ; API/provider |
| consensus | Consultations provider internes malgré requires_model=false |
| apilookup | Retourne web_lookup_needed et instructions ; ni modèle ni recherche interne |
| listmodels | Inventaire fournisseurs/registres, pas inférence ; ne prouve ni droits ni quotas |



### Surcharge isolée proposée, non installée

Registre : built-ins → CLI_CLIENTS_CONFIG_PATH → ~/.pal/cli_clients (prioritaire). Aucune surcharge trouvée. INTERNAL_DEFAULTS rejette codex-analyse. Une instance PAL distincte peut surcharger codex via variable propre au processus ; cela ne neutralise pas PAL/.env ni les autres sources.

JSON proposé, non installé (chemins fictifs) :

```json
{
  "name": "codex",
  "command": "\"C:/Program Files/nodejs/node.exe\" \"C:/ARCHIPEL-ISOLE/pal-analysis-gate.mjs\"",
  "additional_args": ["--json", "--sandbox", "read-only", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--ephemeral", "-c", "approval_policy=\"never\"", "-c", "web_search=\"disabled\""],
  "env": {},
  "timeout_seconds": 90,
  "roles": {"default": {"prompt_path": "C:/ARCHIPEL-ISOLE/analyse-texte.txt", "role_args": []}}
}
```

PAL ajoute exec. env={} ne filtre rien : wrapper env/cwd/arguments/frontière obligatoire, fermé par défaut. Tester shlex/parseur sur faux CLI.

### Les cinq problèmes persistants

1. Catalogue sans outils : **Non démontré**, aucune requête capturée ; unified_exec restait true dans la preuve précédente.
2. Appel forcé sans effet : **Non démontré**, aucune réponse injectée ; un arrêt après événement serait trop tard.
3. Client fichiers/réseau/auth : **Partiel/Échec du canal restreint** ; grants ciblés efficaces, réseau coupé bloque le courtier, réseau ouvert précédent contournable ; HOME vierge sans login.
4. Aucun chargement implicite : **Non démontré** ; instructionSources vide pour un cas, découverte skills utilisateur tentée et refusée, requête finale non observée.
5. Arrêt garanti : **Partiel** ; instantanés sans résidu, Job non validé avec Codex/MXC, PAL ne tue que le parent.

## 2. Recherche et nouvelle sonde

CLI **0.164.0** ; aides et schéma générés en HOME temporaire. exec : read-only, ignore-user-config/rules, ephemeral, strict-config ; auth conservée et ignore-rules limité aux execpolicy. Sandbox : profils/état opaque, aucun flag port-proxy dédié. readOnly local : type/networkAccess sans access ; dynamicTools=[] ne retire pas les outils intégrés. App-server expérimental ; aucun compte/quota appelé.

[Permissions](https://learn.chatgpt.com/docs/permissions) : proxy actif requis, proxy_url=écoute, pas ACL. [MXC Windows](https://learn.chatgpt.com/docs/windows/windows-sandbox) : sans comptes/pare-feu supplémentaires, loopback plus large en réseau géré. Filtre noyau hôte+port non démontré ici ; HTTP_PROXY contournable. 

Sonde : vrai codex sandbox MXC, Node synthétique, serveur TCP fictif 127.0.0.1:56261 sans forwarding. Cwd C:/Windows/Temp/archipel-arch-loopback-ROoHBp/work, HOME frère. :root=deny sans :minimal ; lecture System32/Node/paquet Codex/work, écriture HOME ; network.enabled=false.

```text
<node.exe> <codex.js> -c windows.sandbox="mxc"
-c permissions.narrow.network.allow_local_binding=<false|true>
sandbox -P narrow -- <node.exe> -e <connexion TCP bornée à 1 s>
```

Env : SystemRoot,WINDIR,HOME,USERPROFILE,CODEX_HOME,APPDATA,LOCALAPPDATA,TEMP,TMP. Aucun PATH/proxy/clé hérité. Timeout 12 s/taskkill arbre. Hors MXC : 1 connexion. Sous MXC : **EACCES pour false ET true**, zéro réception, exit Node=0 (pas réussite réseau). Temporaires supprimés.

Loopback inaccessible : aucun nouvel exec/provider. Catalogue/appel forcé non prouvés. Preuve future : canal imposé + faux Responses SSE capturant tools/instructions puis appel forcé, témoins d’effets, sans forwarding. IPC/serveur dans la frontière : non prouvés.

HOME vierge/auth fictive permet le test, pas l’abonnement. Session autonome non établie ; aucun auth.json lu.

Le [guide passerelle](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway) décrit Codex authentifié transmettant son credential, pas un courtier autonome avec HOME vierge. OAuth parfois ≥0.166.0 ; éligibilité/compatibilité non établies, aucun contournement/login.

## 3. Comparaison, routage et décision

| Critère | A : passerelle texte + CLI | B : Responses/Chat sans CLI | C : client MXC + courtier |
|---|---|---|---|
| Sécurité | Partiel : CLI autonome | Outils contrôlables, non réalisé | Fichiers ciblés prouvés, réseau incomplet |
| Faisabilité | Bloquée outils/config/isolation | API/clé interdites | Bloquée réseau/auth/catalogue |
| Complexité | Moyenne, exige C | Faible à moyenne | Forte |
| Coût | Abonnement, coût inconnu | Tokens séparés | Abonnement/exploitation, inconnu |
| Compatibilité | Contrat existant, PAL distinct | Nouveau fournisseur | Profils locaux, RPC expérimental |
| Maintenance | PAL/CLI/flags | API/budget/confidentialité | Windows/MXC/proxy |
| Risques | Outils/config/mémoire PAL | Rétention/injection | Grants/contournement/auth |

B : sans tools, aucun outil API fourni ; sans dispatcher, texte hostile inexécutable.  [Outils](https://developers.openai.com/api/docs/guides/tools). Abonnement≠accès/facturation API ; [crédits conditionnels](https://developers.openai.com/api/docs/guides/chatgpt-api-credits) après liaison pour certains abonnements, sans lever les interdictions. Coût=tokens×[tarifs modèle](https://developers.openai.com/api/docs/pricing), non choisi.

API : sans entraînement par défaut, abus généralement jusqu’à 30 jours ; store=false≠rétention nulle. État/cache/exceptions à examiner, ZDR selon éligibilité ; aucun compte vérifié. [Confidentialité](https://developers.openai.com/api/docs/guides/your-data).

**Refus maintenu.** C=piste abonnement ; A ne résout pas l’isolation. B exige autorisation future API/clé/budget. Aucun prototype validé à construire.

```text
Claude -> PAL distinct -> filtre contexte/provenance + quotas + refus fermé
                              |
                     client ENTIER MXC, HOME dédié, tools vides
                              |
                     canal imposé [MANQUANT] -> courtier -> fournisseur
                              |
                     texte validé/borné -> PAL -> affichage Claude
                     aucune action/commande/patch automatique
```

Routage : revue, bug difficile reproductible, perf, algorithmique, comparaison/vérification si bénéfice>coût/latence, complexité réelle, risque maîtrisé, contexte minimal nettoyé. Sinon local/refus. Plafond contexte, concurrence 1, consultation unique par tâche/empreinte, profondeur 1 ; aucun appel réciproque/retry ; cache révision/politique, limites durée/sortie/budget. Inconnus conservés. Réponse texte structurée constats/preuves/hypothèses/options/incertitudes ; aucun dispatch/action ni instruction privilégiée.

### Dix tests futurs, aucun ajouté

| # | Test | Faisabilité sans modèle réel |
|---|---|---|
| 1 | Lecture hors grants refusée, témoin autorisé | Oui, MXC ; étendre aux chemins alternatifs/jonctions |
| 2 | Écriture interdite refusée, HOME dédiée autorisée | Oui, fichiers fictifs |
| 3 | Config utilisateur/MCP absents | Partiel ; requête finale bloquée par canal local |
| 4 | Skills/plugins/instructions absents | Partiel ; marqueurs sortants non capturés |
| 5 | Catalogue tools vide | Faux provider suffirait ; canal MXC bloqué |
| 6 | Appel forcé sans effet | Même blocage ; absence de requête ≠ réussite |
| 7 | Courtier seul joignable ; autres ports/IP/DNS/UDP refusés | Sondes locales possibles ; preuve complète absente |
| 8 | Arrêt normal/timeout/crash sans enfants résiduels | Oui ; Job avant reprise et imbrication réelle à valider |
| 9 | Erreur CLI/protocole/capacité → refus sans repli | Oui, faux exécutable |
| 10 | Réponse hostile → aucune action Claude | Oui pour dispatcher/affichage simulés ; modèle Claude non prouvé |

Avant activation : cinq critères, auth légitime sans extraction, canal imposé anti-contournement, requête sans outils/chargements, arrêt robuste, filtre avant mémoire et validation réponses/limites. Job/jeton/intégrité basse≠liste blanche fichiers/réseau. [Microsoft](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

Dépendances : 1 audit → 2 recherche → 3 comparaison. Porte réseau échouée, refus maintenu. Prochaine décision : nouvelle preuve canal/auth ; sans construction. Alternative B après changement explicite des contraintes, ou aucune délégation.
