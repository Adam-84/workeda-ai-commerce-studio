# Communication entre agents — audit et conception (Phase 4)

## 1. Audit de l'existant (avant la phase 4)

| Constat | Détail | Décision |
| --- | --- | --- |
| Les agents ne se parlaient pas | Les fiches `.claude/agents` interdisent de « contacter les autres agents » ; `messages` (agent → agent) n'était qu'un enregistrement manuel. | Un vrai système, par-dessus l'existant. |
| `POST /api/messages` sans garde | N'importe quelle page web locale pouvait écrire « au nom » d'un agent. | Gardé (machine locale seulement) ; reste un enregistrement manuel. |
| Pas de moteur d'exécution des missions | `missions.state` valait `draft`, point. Plan, discussion et notes existaient, mais rien n'exécutait. | Une tâche déléguée **est** une mission (ligne `missions`) dont l'état reflète la tâche. |
| Rien n'était synchronisé entre PC | Missions et messages vivent dans la base locale. | Journal git `comm/journal/`, comme la mémoire. |
| Mémoire à 4 niveaux | `contextFor([agents])` ne renvoie que ce que tous peuvent lire. | Réutilisée telle quelle ; `readableBy()` ajouté pour contrôler les références. |
| **Défaut bloquant du runner** | `claude -p … --safe-mode` : cette option n'existe pas dans les Claude Code 2.1.87 et 2.1.101 installés ici → toute réponse d'agent échouait. | Isolation détectée dans `claude --help` (`--safe-mode`, sinon `--setting-sources ""`). |
| Pas d'outil pour les agents | `--tools ""` : aucun agent ne pouvait consulter le web, donc aucun résultat « sourcé ». | Option `tools` limitée à `WebSearch`/`WebFetch`, lecture seule. |

## 2. Architecture

```
Propriétaire ──HTTP local──► app.js (/api/comm/*) ──► comm-run.js (orchestrateur) ──► Claude Code (claude -p)
                                   │                         │ contrôle droits, limites, doublons, quotas
                                   ▼                         ▼
                           studio-comm.js (tables comm_*) ◄── comm-core.js (règles pures, prompts, vérification)
                                   │
                                   ▼
                  comm/journal/<appareil>.jsonl  (git)  ──► autre PC : copie des données, aucune exécution
```

- **Fils** (`comm_threads`) : privé (1–2 agents), département, mission, groupe. Le propriétaire écrit dans tous.
- **Messages** (`comm_messages`) + **accusés par destinataire** (`comm_deliveries` : envoyé → reçu → traité | erreur). Le statut d'un message agrège ses destinataires.
- **Tâches** (`comm_tasks`) = délégations/sous-missions : responsable, demandeur, profondeur, dépendances, échéance, essais, état.
- **Résultats** (`comm_results`) : texte, sources (avec `checked`), consultations observées, verdict `verified`/`level`.
- **Exécutions** (`comm_runs`) : preuve d'un vrai travail (agent, modèle, durée, coût rapporté, web oui/non).
- Tout événement important écrit aussi dans la table `events` existante (`comm.*`) ; l'activité des agents passe par `recordActivity` (source `claude`, vérifiée) : la carte pixel-art n'affiche que ce que le serveur constate.

### Invariants garantis par le stockage
1. Un message d'agent n'existe que rattaché à une exécution réelle de cet agent (`runId`).
2. Une tâche n'est « terminée » que si un résultat **vérifié** existe.
3. Aucun client HTTP ne peut écrire au nom d'un agent.
4. Profondeur, cycles, plafond par demande, messages automatiques, doublons : bornés côté serveur.
5. Un import de journal applique les mêmes règles qu'une écriture locale.

### Vérification d'un résultat (le Studio décide, jamais l'agent)
- `observed` : des sources citées ont été **réellement** consultées (événements `tool_use` + `tool_result` sans erreur du flux Claude Code).
- `derived` : consolidation dont tous les résultats sources sont vérifiés.
- `run` : exécution réelle sans fait externe exigé (plan, synthèse).
- Sinon → état « À vérifier » : le propriétaire relit et valide (`manual`).

## 3. Collaboration

Un agent demande de l'aide via le champ `delegate` de sa sortie JSON. Le Studio : résout le prénom, vérifie le champ `collaborates` de **sa fiche**, applique profondeur (3), cycles (A→B→A refusé), 4 demandes par exécution, 12 tâches par demande, doublons (même agent + même demande complète + même accès web : tâche ouverte ou résultat vérifié < 7 jours réutilisés). Selon la mission, les délégations d'un agent attendent la validation du propriétaire (`requiresApproval`) ou partent seules.
`consolidate` crée, pour l'agent demandeur, une tâche qui **attend** les tâches déléguées (dépendances) puis assemble leurs résultats.

Exemple : Alexander → Sophia (tendances) + Noah (concurrence) → consolidation par Alexander ; Sophia peut demander à Noah, Noah à Sophia, selon leurs fiches.

## 4. Mémoire et confidentialité
- Le contexte mémoire d'une exécution = `contextFor(participants du fil)` : intersection des droits.
- Une exécution **avec accès web ne reçoit aucune mémoire** (une page piégée ne doit pas pouvoir la faire sortir).
- Un agent ne voit d'un fil que ce qui lui a été **adressé** (ou qu'il a écrit) : un participant ajouté après coup ne reçoit pas l'historique.
- Références jointes : contrôlées à l'envoi (lisibles par **tous** les participants) et masquées à la lecture si ce n'est plus le cas.
- Les agents proposent des souvenirs (`memory` dans leur sortie) : toujours « en attente » du propriétaire.

## 5. Sécurité
Messages, rapports d'autres agents, pages web et souvenirs sont des **données non fiables** (`<donnees-non-fiables>`, chevrons neutralisés, titre dérivé jamais montré en clair). Aucun outil hors `WebSearch`/`WebFetch` ; accès web accordé par le propriétaire (jamais par un agent) et seulement si la fiche de l'agent le prévoit. Aucune écriture Shopify possible. Aucun secret : refusé à l'envoi, au résultat et à l'import. Routes `/api/comm/*` : machine locale uniquement, lectures comprises. Aucune API IA payante : Claude Code avec l'abonnement existant ; coûts/jetons tels que rapportés par lui.

## 6. Garde-fous d'exploitation
Concurrence (2 agents actifs), quota 60 exécutions/jour (messages simples = 0 appel), échéance 24 h, 2 essais avec attente, agent indisponible → tâche bloquée et expliquée, reprise après arrêt du Studio, import de tâche d'un autre PC **jamais exécuté d'office** (reprise explicite « Exécuter ici »).

## 7. Migrations
`COMM_MIGRATIONS` v1 (tables `comm_*`), additive, sauvegardée avant application (`data/backups/`), réversible (`rollback`). Aucune table existante modifiée ; seule `emit()` renvoie désormais l'identifiant d'événement, et `missions.state` reçoit les valeurs `queued/running/review/done/failed/blocked/cancelled/expired`.

## 8. Tests
`comm-store` (fils, statuts, droits, délégations, invariants, synchro), `comm-run` (collaboration complète, vérification, boucles, injection, mémoire, erreurs, reprise, quota), `comm-api` (garde local, usurpation, bout en bout, runner), `comm-view`, `comm-cli`, `comm-review` (un test par défaut de la revue Codex). Non-régression de la mémoire : les tests `memory-*` inchangés passent.

## 9. Limites connues
- Les tests simulent le modèle (le reste du pipeline est réel) ; la mission de validation (README) utilise de vrais agents.
- Codex n'est pas un exécuteur d'agents ici : l'orchestrateur accepte n'importe quel `runner`, mais seul Claude Code est branché. Codex peut lire l'état (`npm run comm:inbox -- sophia`).
- Une mission réelle consomme l'abonnement Claude Code ; le coût affiché est celui rapporté par l'outil.
- Les accusés d'un message de groupe restent « envoyé » tant qu'un agent ne l'a pas traité.
- Pas de pièces jointes binaires : seulement des références (souvenir, mission, résultat, message, fil, lien).

## 10. Mission de validation réelle (21 novembre 2026)
Base temporaire, vrais appels à Claude Code, web en lecture seule, aucune écriture Shopify.
- Alexander (plan, exécution réelle) → Sophia (13,9 k caractères, 8/8 sources confirmées, 10 pages lues, 9 recherches) et Noah (8,9 k caractères, 19/20 sources confirmées, 14 pages lues) → consolidation d'Alexander (10,5 k caractères, niveau « dérivé » : 2 résultats vérifiés).
- 5 exécutions terminées, 2,32 $ rapportés par Claude Code. Les agents ont ensuite délégué 6 tâches de suivi (limites respectées) ; Lucas s'est bloqué à juste titre (il exige un accès Shopify). La mission a été arrêtée volontairement pour ne pas dépenser davantage : ses sous-tâches restantes ne sont **pas** terminées.
- Défaut révélé et corrigé : une consolidation dont une dépendance est bloquée attendait sans le dire ; elle est maintenant bloquée avec explication et repart quand on relance sa dépendance.
- Constat : les agents délèguent volontiers. Recommandation : garder `requiresApproval` activé (défaut) pour valider les demandes de suivi.
