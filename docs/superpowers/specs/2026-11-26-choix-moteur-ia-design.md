# Choix du moteur IA par agent ou par mission : conception

Date : 26 novembre 2026. Base : `main` (`4da42c9`). Conception approuvée par le propriétaire (approche « registre de moteurs », trois lots). Le dernier chapitre liste les précisions ajoutées à l'écriture, à confirmer à la relecture. Aucun code n'est écrit.

## But

Choisir quel moteur IA travaille, par agent ou par mission, et compter les usages, coûts et quotas séparément par fournisseur, sans jamais en changer à l'insu du propriétaire. Aujourd'hui seul Claude fonctionne.

## Constats sur le code actuel

1. La discussion directe, le fil d'équipe, la proposition de plan et la proposition de souvenirs (`stream()` dans `src/app.js`) n'enregistrent aucune exécution : coûts et compteurs les ignorent.
2. Un coût inconnu vaut parfois zéro : `usage()` remplace l'absence par 0, `spentOf()` compte 0 $ pour une exécution réussie sans coût rapporté.
3. Claude Code 2.1.101 déclare un événement `rate_limit_event` (`status`, `resetsAt`, `rateLimitType`, `utilization`, `isUsingOverage`) qu'Archipel ignore. Lu dans le code du CLI installé, jamais observé sur une exécution réelle.
4. Le modèle qui a réellement répondu n'est pas enregistré.
5. Le serveur central limite le courtier aux modèles cités par les fiches (`opus`, `sonnet`).

## Approche retenue

Un moteur est un couple (fournisseur, modèle) pris dans un catalogue fermé.

Écartées : un simple sélecteur de modèle (le fournisseur resterait implicite) ; des adaptateurs Codex, Gemini ou API payante (aucun second moteur autorisé, code impossible à tester).

## Catalogue et résolution

Nouveau module pur `src/engines.js` : catalogue, validation, résolution, comparaison du modèle constaté.

| Fournisseur | Modèles | État |
| --- | --- | --- |
| `claude` | `opus`, `sonnet`, `haiku` | Disponible |
| `codex` | aucun | Désactivé : isolation non démontrée, autorisation requise, aucun runner |
| `gemini` | aucun | Non configuré |

Un nom de modèle est un réglage : il ne prouve pas que le compte y a accès.

Ordre de résolution : choix de la mission, sinon choix de l'agent, sinon modèle de la fiche. Les fiches `.claude/agents/` ne changent pas.

- **Agent** : sélecteur sur sa fiche à l'écran. « Fiche (sonnet) » efface le choix. Réglage local, non synchronisé par git.
- **Mission** : sélecteur sur la mission et dans le formulaire de délégation, où « Chaque agent garde le sien » est la valeur par défaut. Le choix est rattaché à la mission racine : il vaut pour ses tâches, sous-tâches, consolidation, fil d'équipe, plan et souvenirs. Si le formulaire vise une mission qui a déjà un choix, il le présélectionne.
- **Discussion directe** : hors mission, donc choix de l'agent.
- **Agents** : le champ `delegate` ne permet aucun choix de moteur. Un texte d'agent n'en change jamais.

## Aucun changement silencieux

- Le moteur est résolu et enregistré à la création de la tâche, puis affiché à la validation. Modifier ensuite un choix d'agent ou de mission ne touche pas les tâches existantes ; les sous-tâches créées après coup suivent le choix en vigueur à leur création.
- Seul le propriétaire change le moteur d'une tâche, par une action explicite, quand elle est à valider, en file, bloquée, en échec, expirée ou à vérifier. Refusé pour une tâche en cours, close ou issue d'une automatisation.
- Une tâche sans moteur enregistré (antérieure à la migration, ou journal ancien) utilise le modèle de la fiche, comme aujourd'hui.
- Un moteur inconnu du catalogue (journal d'une version plus récente) est conservé tel quel : la tâche attend avec le motif.
- Moteur indisponible : la tâche reste en file, avec le motif, sans essai consommé ni repli. Les délais d'expiration actuels s'appliquent. Un appel immédiat (discussion, plan, réponse dans un fil) renvoie une erreur claire.
- La réutilisation d'une demande ou d'un résultat identique tient compte du moteur : le moteur entre dans l'empreinte quand il diffère de celui de la fiche, y compris pour les automatisations.

### Modèle constaté

Le Studio lit le modèle des messages de réponse principaux (hors sous-appels) et compare la famille (`opus`, `sonnet`, `haiku`).

- Identique : rien à signaler.
- Absent : « Inconnu » ; le résultat n'est pas dégradé.
- Différent : une tâche passe « à vérifier » avec les deux noms ; les autres appels affichent un avertissement et l'exécution le conserve.

En mode central, le worker renvoie la liste des modèles constatés dans un champ facultatif et borné, `models` (lot 1). Un serveur ancien l'ignore ; un worker ancien laisse « Inconnu ».

## Comptabilité (lot 1)

- Toute exécution est enregistrée : fournisseur, modèle demandé, modèle constaté, coût et jetons rapportés. Nouveaux types : `chat`, `team`, `plan`, `memory`.
- Ces quatre types restent locaux (aucun contenu, rien dans le journal git), ne comptent ni dans la limite de 60 par jour ni dans le budget d'une mission, et ne soumettent l'appel à aucune condition nouvelle (un échec d'écriture ne bloque pas la réponse).
- Les exécutions antérieures sont rattachées à `claude`, seul moteur branché jusqu'ici.
- `usage()` renvoie `null`, jamais 0, quand aucune donnée n'est rapportée, pour les coûts comme pour les jetons ; un détail par fournisseur et modèle s'ajoute, ainsi que par agent.
- Affichage : « Inconnu » sans donnée ; « 0,50 $ rapportés (2 sur 3 exécutions) » si partiel. C'est le chiffre rapporté par Claude Code sous abonnement, pas une facture. Aucune somme entre fournisseurs n'est présentée comme un montant dû.
- Budget de mission : toute exécution sans coût rapporté, réussie ou en échec, compte 0,25 $ annoncés comme **estimation**. Cela vaut aussi pour l'historique : un budget peut être atteint plus tôt.

## Choix du moteur (lot 2)

- Stockage : table `engine_choices(scope, ref, provider, model, updated_at)`, `scope` valant `agent` ou `mission` ; colonnes `provider`, `model`, `engine_source` sur `comm_tasks`.
- Le journal des tâches transporte le moteur ; à l'import, un champ absent n'efface rien.
- Le lanceur (`src/comm-run.js` et `stream()`) demande le moteur au Studio au lieu de lire `profile.model`.
- La file évalue la disponibilité par tâche et non plus par agent.
- Automatisations : le moteur est celui de l'agent au moment du lancement. Changer le moteur d'un agent affiche d'abord les automatisations actives concernées ; leur vue indique le moteur.
- Routes, derrière l'authentification existante : `GET /api/engines`, `PUT /api/agents/:id/engine`, `PUT /api/missions/:id/engine`, `POST /api/comm/tasks/:id/engine`. Tout moteur désactivé ou hors catalogue est refusé.
- Serveur central : le courtier accepte le catalogue Claude. La liste autorisée de chaque worker reste la règle ; servir `haiku` demande un nouvel enrôlement. Sans worker pour le modèle demandé, la tâche attend.

## Quota observé (lot 3)

Deux notions affichées séparément :

- **Limite interne Archipel** : 60 exécutions par jour (tâches et réponses dans un fil), inchangée.
- **Signal du fournisseur** : dernier relevé daté, par source (cet ordinateur ou un worker) et par fenêtre, dans une table `provider_signals`. Donnée absente ou dont la remise à zéro est passée : « Inconnu ». Taux non transmis : « consommation inconnue ».

Effets :

- Refus (`rejected`) : le moteur concerné attend la remise à zéro, pour la seule source concernée. Les fenêtres propres à `opus` ou `sonnet` ne bloquent que ce modèle. Sans date de remise à zéro, la reprise demande une confirmation.
- Dépense supplémentaire signalée (`isUsingOverage`) : Archipel ne lance plus Claude depuis cette source avant confirmation, valable jusqu'à la remise à zéro annoncée, sinon jusqu'à la fin de la journée. Le signal n'arrive qu'avec une exécution : Archipel ne peut pas empêcher la première.
- Si Claude Code n'émet rien, tout reste « Inconnu » et rien n'est bloqué.
- Route `POST /api/engines/claude/resume` avec confirmation explicite.
- Les workers renvoient un champ facultatif et borné, `quota`, y compris en échec, avec la même compatibilité que `models`.

## Interface

Pixel Art inchangé. Ajouts : sélecteur sur la fiche d'agent (la pastille « Modèle » montre le moteur effectif et son origine), sélecteur sur la mission et la délégation, moteur et action de changement sur la tâche, moteur dans les automatisations, section « Coûts et quotas » de Comms détaillée par moteur, cartes « Coûts IA du jour » et « Quotas fournisseurs » du tableau de bord. Codex apparaît désactivé avec son motif, sans chiffre.

## Données et sécurité

- Une migration additive et réversible par lot, via le mécanisme existant de `src/studio-comm.js`, qui sauvegarde la base avant.
- Fournisseur et modèle sont validés contre le catalogue avant d'atteindre la ligne de commande, la base ou un worker.
- Aucun identifiant de fournisseur stocké ; aucune API payante, aucun compte, aucune écriture Shopify.

## Tests

Bases temporaires et runners simulés uniquement ; `data/workeda.db` n'est jamais ouverte. Aucune IA réelle n'est appelée.

| Lot | À démontrer |
| --- | --- |
| 1 | Les quatre appels hors tâches sont enregistrés sans consommer la limite de 60 ; inconnu et partiel jamais affichés comme zéro ; estimation du budget ; modèle constaté identique, absent ou différent, y compris via un worker ancien ou récent ; migration et retour arrière |
| 2 | Priorité mission, agent, fiche ; moteur figé ; aucun repli ; empreinte par moteur ; choix refusé aux agents ; journaux ancien et inconnu ; disponibilité des workers |
| 3 | Lecture de l'événement ; refus, dépassement, reprise confirmée ; relevé périmé ; compatibilité ancien worker et ancien serveur |

Avant livraison : `node --test --test-timeout=30000` et `node src/skills-cli.js check`.

## Limites assumées

- La séparation par fournisseur n'affiche aujourd'hui qu'une ligne Claude : elle prépare un second moteur sans l'apporter.
- Pas de limites réglables par fournisseur, de routage automatique, de comparaison entre moteurs, ni de runner Codex.
- Aucun chiffre de solde d'abonnement au-delà de ce que Claude Code transmet.
- Choisir `opus` consomme le quota de l'abonnement plus vite.
- Coût externe du développement et des tests : 0 € ; seul l'usage Claude Code habituel est consommé.

## Livraison

Branche à part, un lot après l'autre dans l'ordre 1, 2, 3, chacun utilisable seul. Aucune fusion dans `main` sans autorisation. `docs/LIVRAISON.md` et `docs/WORKERS.md` sont mis à jour avec chaque lot.

## Précisions ajoutées à l'écriture

À confirmer à la relecture ; elles découlent du code et n'étaient pas dans la présentation :

1. Le moteur entre dans l'empreinte des doublons, sinon un résultat produit par un autre moteur serait réutilisé.
2. Les automatisations suivent le moteur de l'agent, avec un avertissement au changement, sans réactivation obligatoire.
3. Le choix de mission est rattaché à la mission racine.
4. Un refus du fournisseur sans date de remise à zéro attend votre confirmation.
5. Après un dépassement, la confirmation vaut jusqu'à la remise à zéro, sinon jusqu'à la fin de la journée.
6. L'estimation de 0,25 $ s'applique aussi aux exécutions passées sans coût.
7. Le moteur d'une tâche issue d'une automatisation ne se change pas à la main.
