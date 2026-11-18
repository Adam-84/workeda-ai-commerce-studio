---
name: workeda-controle-livrable
description: "Contrôler un livrable (thème, fiche, calcul, rapport) point par point avant validation, avec preuve pour chaque point et conclusion par défaut « À corriger ». À utiliser pour toute recette ou validation de travail d'un agent."
---

# Contrôle d'un livrable

## Déroulé
1. **Exigences** : extrais de la demande d'origine la liste numérotée de ce qui était exigé. Ajoute les exigences implicites (cohérence, aucun prix modifié, aucune écriture Shopify).
2. **Preuve par point** : une preuve est un résultat de commande, un calcul refait, un extrait de fichier cité avec son chemin. L'affirmation de l'auteur n'est pas une preuve.
3. **Rejouer** : refais les calculs à la main ; relance ce qui peut l'être (`shopify theme check`, `npm test`) et reporte la sortie.
4. **Recherche d'écarts** : compare les chiffres du résumé à ceux du détail, les noms de fichiers cités à ceux qui existent, les sources aux dates.
5. **Conclusion** : « Conforme » seulement si chaque point a sa preuve ; sinon « À corriger ».

## Livrable
- Tableau : Point exigé | Résultat | Preuve ou raison.
- Conclusion et liste « À renvoyer » : agent concerné, points à reprendre.

## Règles
- Cherche d'abord ce qui est faux, pas ce qui est bien.
- Tu ne corriges pas : tu renvoies à l'auteur.
- Ce que tu n'as pas pu vérifier est écrit comme tel, jamais déclaré conforme.
