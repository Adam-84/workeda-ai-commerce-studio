# Corriger les coûts, l’import et la détection du Shopify App Manager

La Phase 8 initiale est déjà dans `main` via #10. Cette PR corrige les défauts constatés lors de sa recette : des abonnements annuels pouvaient produire un total erroné, un import écraser une correction faite après son aperçu, et la détection contacter les hôtes tiers du HTML.

## Changements

- Totaux annuels calculés en centimes avant arrondi du mensuel équivalent ; montants non finis ou incompatibles avec un agrégat sûr refusés.
- Confirmation CSV refusée avec 409 si l’inventaire a changé depuis l’aperçu ; tableau des lignes désormais visible avant confirmation.
- Limite de 300 fiches appliquée aussi aux créations depuis un indice.
- Détection limitée à une requête GET HTTPS de la page d’accueil, DNS contrôlé et adresses directement utilisées par TLS, sans redirection ni téléchargement de ressources tierces. Réponses compressées refusées ; détection toujours désactivée par défaut.
- Mesure du téléchargement HTML distinguée des indices de scripts, dont l’impact par application reste non mesuré.
- Contexte de Maxime borné sans couper le JSON, avec total et omissions annoncés ; skills et documentation alignés.

## Vérification

- Référence historique `8f9f477` : 474 tests réussis.
- Suite finale : **497 tests réussis, 0 échec, 0 ignoré** ; 22 skills et 11 agents cohérents ; contrôle de format du diff réussi.
- Recette navigateur sur base temporaire : ajout, édition, coûts inconnus, doublons, import invalide/valide, confirmation et accès individuel de Maxime.
- Régressions observées avant correction puis vérifiées après, avec transport et DNS simulés.
- Un audit réel de Maxime sur trois applications fictives via l’abonnement existant : totaux 20 EUR/mois et 240 EUR/an corrects, coût inconnu conservé, recommandations à valider, zéro outil exécuté.
- Dix fiches d’agents d’origine intactes ; protections PAL, runner Codex et veille inchangés. Aucune mutation ni connexion Shopify réelle.

## Limites

Pas de mesure LCP/INP/CLS ni d’impact mesuré par application. L’inventaire dépend des déclarations ; le contexte agent reste limité à 60 fiches au plus, avec omissions explicites. Pas de recette mobile exhaustive ni de test lecteur d’écran. Un cas réel de modèle ne garantit pas ses réponses futures.

Rapport détaillé : `docs/PHASE-8-CODEX-REVIEW.md`.
