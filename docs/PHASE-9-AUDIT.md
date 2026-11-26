# Phase 9 — Audit préalable

Date : 25 novembre 2026. Statut : audit réalisé, développement soumis à validation.

## État vérifié

- Dépôt : `C:/Users/adamg/OneDrive/Documents/VSCODE/workeda-ai-commerce-studio`.
- `main` propre, synchronisé après fetch avec `origin/main`, commit `a562a51` (fusion PR #11, correctifs Shopify App Manager).
- Branche `feat/automation-system` créée depuis ce commit.
- Suite complète existante : **497 tests réussis, 0 échec, 0 ignoré**. Le chiffre historique de 474 est dépassé par les travaux de Phase 8.
- Vérification du catalogue : **22 skills, 11 fiches agents**, cohérents.
- Aucun code produit modifié pendant cet audit. Aucun commit, push ou fusion.

## Réutilisation et limites constatées

| Domaine | Existant et fichiers | Conséquence pour la Phase 9 |
| --- | --- | --- |
| Persistance | SQLite Node, `src/studio.js`, migrations versionnées Memory/Comms avec sauvegarde | Ajouter un store Automation au même modèle ; pas une deuxième infrastructure. |
| File IA | `src/studio-comm.js`, `src/comm-core.js`, `src/comm-run.js` : tâches persistantes, missions, états, expiration, reprise, résultats et budgets | Conserver Comms comme seul chemin d'exécution IA. Une occurrence Automation référence une tâche Comms. |
| Limites Comms | 2 exécutions actives par processus, 2 tentatives, 60 runs/jour, TTL 24 h ; coûts rapportés après exécution | Les limites ne constituent pas un plafond financier garanti ; réserver les places avant dispatch et distinguer consommation constatée/plafond d'appels. |
| Déduplication | Empreinte agent/instruction/permissions/sources, réutilisation de résultats vérifiés jusqu'à 7 jours | Ajouter révision des entrées et de la politique ; un catalogue changé ne doit pas réutiliser aveuglément une ancienne analyse. |
| Reprise | `recover()` reprend les tâches du device ; import Comms conserve le device ; adoption explicite | Réutiliser l'appartenance ; ajouter une liaison idempotente occurrence/tâche et un verrou local atomique. |
| Concurrence | Claim Comms fondé sur sélection puis mise à jour ; concurrence principalement en mémoire | Le lancement automatique impose un claim conditionnel transactionnel et un bail local ; deux processus ne doivent pas lancer le même travail. |
| Approbation | Une racine `createTask(..., {type:'user'})` part immédiatement ; `requiresApproval` ne bloque pas cette racine | Introduire une origine Automation et une autorisation explicite de règle, sans se faire passer pour l'utilisateur. |
| Arrêt | `orchestrator.stop()` retire le timer, sans arrêter les appels déjà actifs ni toutes les relances internes | Ajouter un verrou persistant vérifié avant claim, collecte et lancement IA ; définir l'arrêt des travaux en cours. |
| Disponibilité IA | Détection de présence CLI et erreurs du runner | Présence ne vaut pas authentification/disponibilité. Classer les erreurs et suspendre sans sondages IA périodiques. |
| Catalogue | `src/studio-shop.js`, `src/shop-readonly.js` : cache, hash, refresh single-flight, fraîcheur 24 h, intervalle minimal 5 min, rétention 7 jours | Comparer des snapshots réussis/comparables. `ensureFresh()` peut déclencher du réseau pendant une tâche : rendre cette décision explicite pour Automation. |
| Réseau | Les appels Admin passent par le verrou réseau ; le catalogue public utilise directement le fetch fourni | Ajouter un consentement de collecte automatique qui protège aussi le public ; ne pas déduire ce consentement d'un ancien usage manuel. |
| Intégrations | Grants individuels sans défaut, projections bornées, quotas, `src/integrations.js`, `src/studio-integrations.js` | Intersection des sources demandées, autorisées par l'utilisateur et permises à l'agent, vérifiée à l'exécution. |
| Logistique | Analyse déterministe `analyzeLogistics` dans `src/integrations-core.js` | Réutiliser les anomalies sur données présentes. DSers Basic reste manuel ; Track17 seulement si déjà disponible et autorisé, sans inscription ni API payante. |
| Apps Shopify | Inventaire local, imports avec aperçu/confirmation, coûts connus, provenance, détection publique facultative avec confirmation par lancement | Auditer le cache local ; ne pas automatiser la confirmation de détection publique. Aucune installation/désinstallation. |
| Marges | Prix Admin parfois avec devise, coûts fournisseurs partiels ; prix publics sans devise garantie | Ne calculer qu'avec correspondance produit, unités et devises compatibles ; afficher « indisponible » autrement. |
| Prix concurrents | Pas d'historique structuré ni de connecteur de prix comparable | Déclencheur non disponible tant qu'une source structurée réelle et autorisée n'existe pas. Une réponse web narrative ne suffit pas. |
| UX/tendances/KPI | Pas de source native de sessions, conversion ou mesures Web Vitals | Les modèles décrivent les données manquantes ; aucun taux de conversion ni impact performance inventé. |
| Événements | Table `events` générique, sans flux typé ; `setMissionState()` n'émet pas systématiquement un événement terminal | Ajouter des événements typés aux transitions effectives et des curseurs durables, sans interpréter le texte libre des anciens événements. |
| Identité PC | Device conservé en base Memory ; une copie de base copie aussi cette identité | Une base copiée n'offre pas une preuve de PC unique. Activation locale séparée, désignation explicite du PC et transfert manuel. |
| Planification | Le serveur démarre Comms et ses timers ; aucun ordonnanceur métier, service système ou daemon | Exécuter seulement lorsque le serveur Archipel fonctionne. PC éteint/veille : pas de garantie horaire. |
| Interface | Pixel Art, panneaux Comms/Integrations, `public/app.js`, `public/style.css` | Ajouter un panneau Automation cohérent, conserver le monde et les 11 agents. |
| API locale | `assertLocalWrite` et contrôle de provenance dans `src/app.js` | Étendre la protection à toutes les routes Automation, y compris les lectures contenant des objectifs ou historiques privés. |
| Watch | `.github/workflows/codex-watch.yml` | Veille préservée ; elle ne devient pas un scheduler métier. |

## Contraintes qui conditionnent la conception

1. Git synchronise des définitions, pas un verrou distribué. Deux PC déconnectés activés indépendamment ne peuvent pas garantir « une seule exécution mondiale ». La proposition locale désigne un PC propriétaire ; une garantie forte multi-PC simultanée exigerait un coordinateur central.
2. Une activation de règle ne donne aucune permission supplémentaire. Modifier/importer une définition révoque sa validation d'exécution jusqu'à revue locale.
3. Les actions sensibles restent soumises à validation humaine. Memory conserve son circuit pending. Aucun nouveau chemin d'exécution Codex, PAL ou API payante.
4. Les tests suivants seront simulés ; aucune boutique réelle, installation, client ou dépense n'est nécessaire.

## Livrables de cette étape

Ce rapport et le plan `docs/superpowers/plans/2026-11-25-automation-system.md`. Le développement commencera uniquement après validation du plan et de ses décisions explicites.
