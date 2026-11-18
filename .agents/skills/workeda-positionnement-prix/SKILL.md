---
name: workeda-positionnement-prix
description: "Comparer le prix de Workeda à celui des concurrents relevés par Noah et proposer un positionnement (plancher, conseillé, plafond) cohérent avec la marge. À utiliser après un relevé de prix pour décider d'un niveau de prix."
---

# Positionnement prix

## Méthode
1. **Entrées** : relevés de Noah (avec date et source) et coût total calculé avec `workeda-calcul-marge`. Sans l'un des deux, écris « donnée manquante » et arrête-toi.
2. **Comparables** : ne garde que les offres comparables (même produit, même quantité, même livraison). Les autres sont listées à part.
3. **Fourchette** : plus bas, médian et plus haut des prix comparables, en prix livré. Avec moins de 3 comparables, signale que la fourchette est fragile.
4. **Trois niveaux** :
   - plancher : le prix qui garantit la marge minimale, jamais en dessous ;
   - conseillé : dans la fourchette marché, au-dessus du plancher, justifié par ce que Workeda offre en plus ;
   - plafond : au-delà, l'écart avec le marché devient difficile à justifier.
5. **Écart** : écart en valeur et en pourcentage avec sa formule, par rapport à la médiane.

## Règles
- Le prix du marché est un repère, pas un objectif : ne descends jamais sous le plancher pour suivre un concurrent.
- Chaque recommandation affiche sa formule, ses hypothèses et la date des relevés.
- Aucune modification de prix : une personne valide.
