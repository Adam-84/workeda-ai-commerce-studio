# Phase 9 — Automation System : plan proposé pour validation

Date : 25 novembre 2026. Base : `a562a51`, branche `feat/automation-system`.

**Statut : proposition détaillée, pas une implémentation. Aucun commit/push/fusion autorisé par ce document.**

## Résultat attendu

Programmer des collectes autorisées, évaluer des événements et conditions sans IA, puis créer si utile une mission Comms dans les limites explicitement approuvées. Toutes les créations, importations et modèles restent désactivés. Les dix modèles utilisent les agents existants ; aucun douzième agent.

Flux : règle validée et activée → occurrence unique → vérification permissions/limites → cache ou collecte autorisée → comparaison déterministe → aucun changement / validation humaine / tâche Comms → résultat et historique sourcés.

## Décisions proposées à valider ensemble

| Décision | Proposition | Limite explicite |
| --- | --- | --- |
| Exécution | Un PC désigné pour les automatismes locaux ; serveur Archipel ouvert | Aucun réveil du PC, service Windows ou déploiement cloud. Garantie multi-PC hors ligne impossible sans coordinateur. |
| Horaires | Europe/Paris ; instants UTC en base ; heure inexistante au printemps ignorée, heure répétée en automne exécutée une fois au premier passage ; jour mensuel absent ignoré | Ces choix apparaissent dans l'aperçu avant activation. |
| Rattrapage | Une occurrence récente au maximum par règle après interruption, fenêtre 24 h ; occurrences anciennes journalisées comme ignorées | Aucun lancement en rafale. Première activation : planifier le futur, sans rejouer le passé. |
| IA | Autorisation IA distincte par règle, pour analyses en lecture seule ; défaut désactivé ; actions sensibles en attente humaine | Réutiliser l'abonnement/runner existant autorisé, jamais le runner Codex interne ni une API payante. |
| Limites proposées | 1 IA par occurrence, 5 appels IA/jour/règle, 20/jour pour Automation, 1 IA Automation active dans le plafond Comms de 2 ; intervalle minimal 15 min | Les échecs facturables consomment le quota. Les quotas Comms existants restent prioritaires. Budgets/tokens rapportés limitent les appels suivants, sans promettre un plafond dur pendant un appel. |
| Arrêt général | Arrêter immédiatement toute nouvelle collecte et tout nouveau lancement Automation ; laisser finir l'appel déjà engagé, afficher son état | Ne pas prétendre tuer un processus sans support d'annulation fiable. Les tâches manuelles Comms restent utilisables. |
| Prix concurrents | Livrer le type de déclencheur et l'état « source manquante », sans nouveau connecteur dans ce périmètre | Ajouter un import structuré ou connecteur réel demanderait un périmètre validé. Pas de collecte fictive ni de scraper implicite. |
| Dates/fuseaux | Petite dépendance locale `@js-temporal/polyfill`, version figée et vérifiée avant ajout ; import explicite, aucun patch global | Le Node installé n'expose pas Temporal. Dépendance uniquement pour les calculs calendaires, pas de cron/service externe. |
| Historique | Métadonnées et états 90 jours ; contenus sources selon leur rétention actuelle ; registre de déduplication conservé tant que la règle existe | Aucune prolongation implicite des données clients ou snapshots. Purges bornées et pagination. |

La dépendance est une proposition, pas une installation effectuée. Source primaire consultée : [documentation du polyfill Temporal](https://github.com/js-temporal/temporal-polyfill), compatible ESM et importable sans modifier les objets globaux. Revalider version, licence et dépendances transitives lors de l'implémentation ; si l'ajout est refusé, replanifier le calcul de fuseaux avant de coder.

## Contrat des règles et des exécutions

Définition portable versionnée : `id`, `schemaVersion`, `revision`, nom, agentSlug, objectif borné, type de déclencheur, horaires/fuseau, conditions typées, références de sources, fraîcheur maximale, cooldown, limites proposées, mode IA demandé. Pas de script utilisateur, expression JS, commande shell ou URL arbitraire exécutable.

État local non portable : activation, approbation de la révision, PC propriétaire, consentement de collecte automatique, consentement IA, prochaine échéance, pause globale, compteurs, baux et historique. Les identifiants sensibles et secrets restent dans les mécanismes existants. Une définition modifiée augmente la révision et suspend son activation jusqu'à revalidation ; la révocation d'un grant bloque immédiatement ses futures utilisations.

États d'occurrence : `queued`, `collecting`, `evaluating`, `awaiting_approval`, `waiting_ai`, `dispatched`, `done`, `skipped`, `blocked`, `failed`, `expired`, `uncertain`, `cancelled`. Chaque transition contient date, motif typé, références de preuves et version de règle. `dispatched` attend la fin de sa tâche Comms ; un résultat IA n'est jamais marqué vérifié uniquement parce que le processus s'est terminé.

Types d'actions limités : actualisation en lecture seule autorisée, évaluation déterministe, création de recommandation/mission, analyse IA Comms si consentement. Aucune primitive d'écriture Shopify ou de paiement.

## Planification, conditions et événements

- Horloge injectée ; calcul de prochaine échéance pur et borné. Horaires précis ponctuels, jours/semaine/mois et intervalles. Intervalles fixes en UTC ; calendriers dans Europe/Paris. Recalcul au redémarrage et lors d'un changement de règle ; horloge reculant n'efface pas les clés déjà consommées.
- À l'arrêt ou désactivation, invalider les occurrences pas encore engagées ; reprendre ne rejoue pas celles annulées. Le lancement manuel est une action explicite unique, possible sur une règle désactivée après aperçu ; il n'active pas son calendrier et reste bloqué par l'arrêt général, les permissions et quotas.
- Événements métier typés : `catalog.changed`, `competitor.price_changed`, `logistics.anomaly`, `mission.done`, `mission.failed`, `recommendation.pending`. Le premier snapshot établit une référence sans simuler un changement. Échec, données tronquées, portée ou devise différente ne deviennent pas une suppression ou un prix nul.
- Émettre les événements missions/recommandations à leurs transitions réelles et une seule fois ; l'import historique n'émet pas de nouveaux événements locaux. Les règles nouvelles ignorent les événements antérieurs à l'activation, sauf lancement manuel explicite sur un snapshot choisi.
- Conditions déclaratives : variation absolue/pourcentage, fraîcheur dépassée, marge sous seuil lorsque prix/coût/devise/unité correspondent, anomalie d'une métrique effectivement disponible. Un seuil en pourcentage avec ancienne valeur zéro est indisponible, jamais infini.
- Marge annoncée comme marge sur les coûts connus uniquement : `(prix - coûts connus) / prix`, prix strictement positif ; devises identiques, frais/taxes absents signalés. Aucun taux de change supposé ni marge nette inventée.
- Conditions à franchissement : produire un événement à l'entrée dans l'anomalie, réarmer à la sortie, cooldown par sujet pour éviter les répétitions. Persister l'état des conditions après redémarrage.
- Éviter les boucles : conserver `causalRoot`, l'automatisation d'origine et une profondeur maximale de 3 ; ignorer par défaut ses propres missions/résultats et toute chaîne dépassant ce plafond. Dédupliquer événement + règle/révision + sujet avant tout travail.

## Persistance, transactions et reprise

Nouveau store `src/studio-automation.js` sur la même connexion SQLite, migrations versionnées additives et sauvegarde existante avant migration d'une base remplie. Tables proposées : définitions, activation locale, état global, occurrences, observations/curseurs, transitions, réservations de quotas et baux. Index uniques sur les clés d'occurrence et de liaison Comms ; index état/échéance/propriétaire pour les claims. Ne pas purger les clés nécessaires à éviter un rejeu encore possible.

Clé temporelle : règle + révision + instant UTC du créneau ; clé événementielle : règle + révision + événement + sujet. UUID de run distinct de cette clé. Les reprises conservent la même occurrence et ses liens.

Claim transactionnel conditionnel (`BEGIN IMMEDIATE`/compare-and-set), bail court renouvelable, vérification propriétaire/pause avant toute opération externe. Réserver concurrence et quota dans la même transaction que le claim. Un second processus local ne peut prendre un bail valide ; après expiration, distinguer travail déterministe relançable et appel IA au résultat inconnu.

**Dispatch Comms atomique :** ajouter une clé d'origine Automation unique aux tâches Comms et une entrée d'idempotence stable. Refactoriser le minimum de `createTask` pour que mission, thread, tâche et lien occurrence soient créés dans une même transaction sur la même connexion, sans transactions imbriquées. Une nouvelle tentative du même dispatch retrouve sa tâche. Ajouter l'origine Automation et vérifier ses consentements côté store, sans appeler le chemin « user » pour s'attribuer une approbation. Adapter également le claim Comms en atomique pour les deux processus locaux.

Après crash : réconcilier d'abord le lien existant, l'état de la tâche et ses résultats. Une collecte/évaluation déterministe peut reprendre au plus deux tentatives avec backoff ; une tâche Comms respecte aussi son plafond total existant, sans multiplier les tentatives à chaque tick Automation. Si un appel IA a pu aboutir sans résultat durable, marquer `uncertain` et demander une décision, sans relance automatique. La reprise Comms des tâches Automation devra respecter cette distinction ; les tâches manuelles conservent leur comportement documenté.

Import/export Git : seules les définitions explicitement exportées sont portables, format JSON borné et validé, aucune activation/queue/exécution/token. Import identique idempotent ; modification ou conflit demande revue, aucune dernière écriture ne peut activer une règle. Une base restaurée/copiée démarre sans autorité automatique tant que le PC n'est pas confirmé localement. Le propriétaire et son jeton local ne voyagent pas dans Git ; configuration locale hors base portable, liée à la machine et vérifiée au démarrage. La copie intégrale de ce jeton avec une machine clonée ne peut pas être détectée sûrement hors ligne : cette limite est affichée, pas cachée par un device en base.

Transfert de propriétaire : désactiver l'ancien PC et exporter les seules définitions ; confirmer sur le nouveau sans reprendre les runs importés. Si l'ancien PC est inaccessible, avertir que son arrêt ne peut pas être garanti et exiger confirmation explicite. L'interface prépare ce contrat pour une future autorité centralisée, sans service cloud aujourd'hui.

## Réseau, sources, caches et IA

Chaque occurrence conserve la provenance, dates, portée, hash et état partiel des entrées. Réutiliser un résultat uniquement si agent, politique/révision, permissions, hash des données et fenêtre de fraîcheur sont compatibles ; aucune réutilisation fondée uniquement sur le texte de la mission.

Collecte hors IA. Avant toute requête : vérifier consentement automatique de la source, grant de l'agent, verrou réseau, fraîcheur, quota et Retry-After. Dédupliquer les demandes de collecte concurrentes pour une même source ; respecter les limites existantes. Les tâches IA Automation reçoivent le snapshot sélectionné ; adapter `ensureFresh()` afin qu'elles ne rafraîchissent pas silencieusement leur catalogue pendant l'appel. Si la source expire entre préparation et lancement, refaire l'évaluation ou bloquer selon la règle.

DSers Basic et imports CSV restent manuels ; analyser leurs derniers snapshots en indiquant leur fraîcheur. Aucune automatisation de la confirmation d'import ou du scan public d'apps. Admin disponible uniquement si déjà configuré, autorisé et consenti ; aucune nouvelle portée client. Les règles de reporting partent de données agrégées déjà accessibles, sans nouveaux objets clients dans les prompts ou journaux.

Collecteurs et calculs continuent sans IA. Pour les missions IA : consentement explicite de la révision, une place réservée, quotas journaliers évalués en Europe/Paris pour Automation (Comms conserve son propre compteur existant, également vérifié), et erreurs d'authentification/indisponibilité classées. Indisponibilité → `waiting_ai`, pas une boucle de sondes CLI/IA. Reprise après action explicite de l'utilisateur ; l'expiration empêche un réveil tardif en rafale. Erreur transitoire connue avant résultat : reprise bornée dans le même budget ; résultat incertain : validation humaine.

Les coûts/tokens absents sont « inconnus », jamais zéro. Un budget consommé ou inconnu selon la politique stricte suspend les nouveaux appels. Plafond dur garanti sur nombre d'appels et concurrence ; plafond en tokens/coût seulement sur consommation observée et prévision réservée, puisqu'un appel existant peut dépasser une estimation. Aucun passage à une API payante pour contourner une indisponibilité.

## Automation Center et modèles

Panneau Pixel Art utilisant les helpers et la navigation existants, sans refonte du monde. Liste : agent, état explicite, sources disponibles/manquantes, prochaine échéance Paris et UTC, dernière exécution et motif d'arrêt. Formulaire borné par type, aperçu des cinq prochains créneaux, permissions effectives, collecte automatique et IA séparées ; confirmation explicite d'activation. Historique paginé avec preuves et lien vers mission Comms, tentatives, consommation connue/inconnue et erreurs utiles sans secrets. Bouton de suspension générale toujours visible et état persistant après redémarrage.

| Modèle désactivé | Travail déterministe / données | IA éventuelle et limite |
| --- | --- | --- |
| Noah | Comparer un futur flux concurrent structuré ; source actuellement manquante | Synthèse de données autorisées ; pas de promesse de surveillance réelle sans source. |
| Sophia | Fraîcheur de rapports et observations accessibles | Synthèse de tendances sourcées ; recherche web seulement si permission existante et explicitement choisie, sans prix structuré déduit du texte. |
| Lucas | Diff et complétude du catalogue | Audit ciblé sur changements pertinents. |
| Isabella | Prix/coûts connus, compatibilité et seuils | Recommandations, aucune modification de prix. |
| Maxime | Inventaire apps local, coûts connus, chevauchements | Audit sourcé ; détection publique manuelle, aucune app installée. |
| Chloe | Signaux catalogue/apps et éventuels rapports fournis | Hypothèses UX/CRO distinctes de mesures réelles. |
| Benjamin | Agrégats existants et fraîcheur ; ventes indisponibles si aucune source autorisée | Reporting signalant explicitement les KPI absents. |
| Alexander | Résultats vérifiés récents et non déjà synthétisés | Synthèse stratégique bornée, sans relancer tous les agents. |
| Olivia | Transitions et retards des missions | Suivi déterministe d'abord ; escalade utile et sans boucle. |
| Harper | Contrôles qualité sur données disponibles | Analyse ciblée des anomalies ; pas de nouvelle permission. |

Un modèle ne crée aucun grant et ne démarre aucun collecteur. Une source manquante est un état visible ; aucune donnée de démonstration n'entre dans les observations de production.

## Lots d'implémentation après accord

Chaque lot fournit son diff et sa vérification, sans commit automatique. Les noms de fichiers ci-dessous définissent la responsabilité technique ; adapter les détails aux conventions du dépôt sans élargir le périmètre.

### 1. Contrats et calendrier purs

- Créer `src/automation-core.js` (validation bornée, états, conditions, clés, limites) et `src/automation-schedule.js` (calcul des créneaux, DST, rattrapage).
- Après accord sur la dépendance seulement : `package.json` et verrou npm pour le polyfill ; aucun réglage global.
- `test/automation-core.test.js`, `test/automation-schedule.test.js` : exemples métier, pas tests de détails privés. Cas Paris 28/03/2027 02:30 absent et 31/10/2027 02:30 répété ; février/31, années bissextiles, UTC, heures limites, redémarrage et recul horloge, intervalles et échéance ponctuelle.
- Acceptation : prochaine échéance déterministe, un seul créneau ambigu et aucune boucle de rattrapage.

### 2. Store, migration, déduplication et autorité locale

- Créer `src/studio-automation.js`, rattacher le store dans `src/studio.js`. Injecter horloge et identité d'exécuteur pour tests.
- Définir jeton d'autorité local hors éléments portables dans le dossier local de données ; ne toucher ni aux réglages globaux ni aux profils runner.
- Ajouter validation et export/import de définitions, disabled par défaut, quotas réservés, baux, curseurs et purge de métadonnées.
- `test/automation-store.test.js` : migration d'une base Phase8 remplie, sauvegarde, second démarrage idempotent, ancien contenu intact ; deux connexions et claim concurrent ; crash après réservation ; import sur second PC sans activation ; changement de révision/grant ; copie de base sans jeton ; purge ne réactive jamais un ancien créneau.
- Acceptation : aucune occurrence n'est créée/exécutée simplement parce qu'un fichier est importé.

### 3. Observations et adaptateurs de sources existantes

- Créer `src/automation-sources.js` et événements typés ; adapter `src/studio-shop.js`, `src/integrations.js`, `src/studio.js` et les transitions Comms/recommandations où nécessaire.
- Réutiliser les fonctions pures d'analyse logistique/apps, les caches et projections existants ; ne pas ajouter de connecteur prix/tendances/analytics.
- `test/automation-events.test.js` : baseline, vrai diff, snapshot partiel, source expirée, échec, devise inconnue, coût absent, seuil/retour normal/cooldown, mission terminée une fois, recommandation pending, import sans replay, absence de boucle causale.
- Acceptation : toute alerte référence une observation réelle ; source inconnue signifie indisponible.

### 4. Liaison Comms, exécuteur et suspension

- Créer `src/automation-run.js`, brancher au serveur dans `src/server.js` avec start/stop explicites et sans ouverture réseau par défaut.
- Modifier au minimum `src/studio-comm.js`, `src/comm-core.js`, `src/comm-run.js` : origine et clé idempotente, transaction partagée pour création, claims atomiques, clé de cache avec révision/hash, contrôles au lancement, reprise des appels incertains et tâches Automation distinctes des tâches manuelles.
- S'assurer que créer mission/thread ne laisse aucun déchet si la transaction échoue ; ne pas contourner le contrôle d'approbation de racine.
- `test/automation-run.test.js` et extension ciblée de `test/comm-store.test.js` : crash avant/après insertion de tâche et avant/après résultat, une seule mission, bail expiré, quotas concurrents, coût inconnu, expiration, désactivation pendant attente, arrêt pendant collecte et avant launch, fin d'un appel déjà engagé, IA indisponible sans boucle, permission révoquée après enqueue et avant run.
- Acceptation : zéro appel réseau/IA dans ces tests, aucune reprise IA incertaine sans décision ; le chemin manuel Comms reste couvert par ses tests existants.

### 5. API et interface

- Étendre `src/app.js` : routes locales `/api/automations` pour liste/création/édition, activation, aperçu calendrier, run manuel, historique, pause globale et import/export. Validation serveur systématique, limites de corps/listes, erreurs 4xx stables et lectures privées protégées.
- Ajouter `public/automation-ui.js`, bouton dans `public/index.html`, navigation/focus dans `public/app.js`, styles dans `public/style.css`.
- `test/automation-api.test.js` : origine/localhost, injection/texte importé, grants, révision en conflit, activation explicite, stop persistant, run manuel sans activation ; aucune route ne permet d'exécuter une commande ou confirmer automatiquement un scan public.
- Vérification visuelle locale sur données fictives clairement identifiées, puis accessibilité clavier/focus/erreurs. Montrer prochaine date, source manquante, budget inconnu et appel en cours au moment d'un arrêt.

### 6. Modèles, guide et régressions

- Créer `src/automation-templates.js` (dix modèles inactifs), `docs/AUTOMATION-SYSTEM.md`, et guide opérateur : activation, consentements, limites, transfert PC, restauration, reprise après indisponibilité et futur serveur.
- `test/automation-templates.test.js` : agents existants, absence de grants implicites, tous inactifs, capacités manquantes visibles. Conserver les assertions des 11 agents existants.
- Exécuter les nouveaux tests ciblés, puis `npm test` et `node src/skills-cli.js check`. Vérifier diff de permissions, profils, Watch et réglages globaux ; rapport final avant toute demande de commit/push/fusion.
- Acceptation : les 497 tests de référence et les nouveaux cas métier passent ; aucune automatisation active après installation/migration/import, aucun vrai compte contacté par les vérifications.

## Architecture future et hors périmètre

Séparer calcul de politique, store transactionnel, adaptateurs de sources et worker permet ultérieurement une autorité cloud avec base partagée et baux centraux. Cette phase ne déploie rien et n'introduit ni Redis, ni service Windows, ni scheduler GitHub métier. Les connecteurs concurrents/analytics nouveaux, la détection publique périodique avec changement du consentement, l'annulation forcée d'un processus IA et une garantie multi-PC simultanée sont des extensions à valider séparément.

## Point d'arrêt

Les seules modifications de cette étape sont les documents de planification. Attendre la validation utilisateur des décisions ci-dessus avant d'installer la dépendance ou de développer les lots 1 à 6. Ne pas créer de commit, push ou fusion sur la seule base de cette validation du plan : présenter d'abord le rapport des changements et limites demandé.
