# Rapport de validation — Phase 5 (Shopify en lecture seule + budget)

Date : 21 novembre 2026 · Code : branche `shopify-readonly`, commit `251118b` · 336 tests verts.

## Mission réelle (Lucas, audit du catalogue Workeda)
Paramètres : Lucas seul, catalogue réel en lecture seule, aucune recherche web, aucune délégation (validation humaine requise), budget 3 $, base temporaire, aucune écriture Shopify.

| Contrôle | Résultat |
| --- | --- |
| Relevé réel | 13 collections, 38 produits, sans erreur (pages publiques, GET uniquement) |
| Données transmises à Lucas | **38 produits sur 38** (38 identifiants uniques), 13 collections, aucune troncature annoncée |
| Rapport : couverture | **38 produits sur 38 cités** (titre, série ou identifiant) |
| Tâches / délégations | 1 tâche, aucune délégation, aucun outil donné (`tools: []`) |
| Statut final | « Terminé », niveau **fourni** (source du relevé daté, non consultée par l'agent) |
| Coût rapporté | **0,47 $ sur 3 $** (1 exécution, 372 s) |
| Cohérence (`comm:check`) | aucun problème |

## Ce que « Terminé » ne garantit pas
Le niveau « fourni » signifie : la source citée est bien le relevé fourni par le Studio. Il ne valide **ni l'exactitude ni la pertinence** des recommandations. Recoupements faits avec les données transmises : type de produit vide sur 38/38 (exact), 23 produits sans étiquette (exact), collection « Page d'accueil » vide (exact).

## Points nécessitant une vérification humaine
1. **Rapport coupé** : il fait exactement 24 000 caractères et s'arrête en plein milieu de l'action n° 4 de la synthèse. La limite de taille du Studio tronque **sans le signaler**, et la tâche est quand même « Terminée ».
2. **Fausse limite signalée par l'agent** : il écrit que « le 5e tag est probablement tronqué dans l'export ». C'est un artefact du format compact du prompt (4 étiquettes listées sur 5) et non un défaut de la boutique.
3. **Chiffres de synthèse** (54 problèmes, répartition par priorité, « 10 titres mal accentués »…) : non recoupés un par un.
4. **Types de produit proposés** : déduits des titres et collections (hypothèse de l'agent) ; à valider avant toute application.
5. **Changements d'adresse (handles)** : l'agent propose de renommer des adresses de produits ; cela exige des redirections 301 dans Shopify, sinon perte de référencement.
6. **Alt textes d'images** : non contrôlables depuis un relevé public.
7. **Recommandations de prix ou de marge** : à soumettre à Isabella ; rien n'a été vérifié ici.

## Défauts révélés — CORRIGÉS ensuite (voir `test/phase5-fixes.test.js`)
- **D1 — troncature silencieuse d'un rapport** à 24 000 caractères (même famille que le défaut du relevé tronqué corrigé auparavant) ; un résultat tronqué ne devrait pas être « Terminé » sans avertissement.
- **D2 — délai de 3 minutes trop court** pour un audit complet : la première tentative a expiré (aucun coût rapporté), la seconde a dû être lancée avec 10 minutes (373 s nécessaires).
- **D3 — le coût d'une exécution expirée n'est pas rapporté** : le budget ne peut pas le compter. Dépense réelle des tentatives interrompues : inconnue.
- **D4 — format compact des étiquettes** (4 sur 5 affichées) qui induit l'agent en erreur.
- Estimation de coût initiale (0,2 à 0,3 $) sous-estimée : coût réel 0,47 $.

## Verdict
La chaîne Phase 5 fonctionne de bout en bout : relevé réel en lecture seule, 38 produits transmis et couverts, aucune écriture Shopify, budget compté, statut cohérent avec la preuve. **Elle n'est pas pour autant sans réserve** : D1 à D4 sont à corriger avant de s'appuyer sur ces audits ou de fusionner dans `main`.

## Correctifs appliqués après la mission (D1 à D4)
- **D1** : un rapport trop long est coupé avec un marqueur visible (« RAPPORT TRONQUÉ PAR LE STUDIO … »), jamais « vérifié » ni « Terminé » (état « À vérifier »), et la consigne annonce la limite (20 000 caractères, résumer et annoncer ce qui manque).
- **D2** : délai d'une tâche sans web porté à 10 minutes ; une simple réponse de fil garde 3 minutes.
- **D3** : une exécution interrompue sans coût rapporté compte 0,25 $ (estimation prudente, affichée) dans le budget au lieu de 0.
- **D4** : jusqu'à 6 étiquettes listées par produit, le surplus annoncé (« +N autres »).
- Non refait : la mission n'a pas été relancée avec ces correctifs ; le verdict ci-dessus reste celui de l'exécution du 21 novembre.
