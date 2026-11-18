---
name: workeda-calcul-marge
description: "Calculer la marge brute et nette d'un produit Workeda avec formule visible, TVA, livraison, frais de paiement et d'applications, coût fournisseur, et proposer prix plancher et prix conseillé. À utiliser pour tout calcul de marge ou de prix."
---

# Calcul de marge

## Données à réunir (chacune avec source et date)
Prix de vente TTC · taux de TVA applicable · coût d'achat fournisseur · livraison fournisseur · frais de paiement (pourcentage et montant fixe) · frais d'applications · autres frais fournis.
Une donnée absente est « donnée manquante » : le calcul qui en dépend s'arrête, il ne se complète pas à l'estime.

## Formules (écris-les dans le livrable)
- Prix HT = Prix TTC ÷ (1 + taux de TVA)
- Frais de paiement = Prix TTC × pourcentage + montant fixe
- Coût total = achat + livraison fournisseur + frais de paiement + frais d'applications
- Marge brute (€) = Prix HT − Coût total
- Taux de marge = Marge brute ÷ Prix HT (la marge rapportée au prix de vente)
- Taux de marque sur coût = Marge brute ÷ Coût total (ne pas confondre avec le précédent : nomme toujours celui que tu donnes)
- Prix plancher HT = Coût total ÷ (1 − marge minimale demandée), la marge minimale étant exprimée en part du prix de vente
- Les frais de paiement dépendant du prix TTC, résous le plancher en tenant compte de cette dépendance ou écris l'approximation retenue.

## Règles
- Arrondis uniquement à la fin du calcul.
- Une seule devise par calcul ; si une conversion est nécessaire, note le taux, la source et la date.
- Montre un exemple chiffré refait à la main sur une ligne pour que Harper puisse le rejouer.
- Tu proposes un prix ; tu n'en modifies aucun.
