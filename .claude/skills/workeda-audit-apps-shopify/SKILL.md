---
name: workeda-audit-apps-shopify
description: "Auditer l'inventaire déclaré des applications Shopify de Workeda (doublons fonctionnels, coûts connus, utilité commerciale) et classer les recommandations garder, remplacer ou retirer, sans jamais présumer des applications installées. À utiliser pour un audit des applications."
---

# Audit des applications Shopify (lecture seule)

## Ce que tu sais et ce que tu ne sais pas
- Tu ne connais **aucune** application installée par toi-même : tu n'as que l'inventaire fourni par Archipel (déclaré par le propriétaire).
- Statut **Déclarée** ou **Détectée** = non vérifié. Seul **Confirmée** a été vérifié par le propriétaire dans son admin Shopify.
- Un coût **inconnu** reste « inconnu » : jamais de zéro, jamais d'estimation, jamais de prix repris de mémoire.
- Si aucun inventaire n'est fourni, dis-le et demande au propriétaire de le déclarer ; ne liste aucune application « courante ».

## Grille par application
1. **Fonction** : que fait-elle, et une autre application ou le thème fait-il la même chose ? (doublon fonctionnel possible, à vérifier)
2. **Coût** : montant, devise, périodicité tels que déclarés ; coût annuel équivalent seulement si le montant est connu.
3. **Utilité commerciale** : quel effet attendu sur la vente (conversion, panier moyen, fidélisation, confiance, logistique) et quelle preuve l'étaye. Sans preuve : « utilité non démontrée ».
4. **Impact mesuré** : seulement si une mesure liée à l'application existe ; sinon « impact non mesuré ».
5. **Fraîcheur** : fiche non mise à jour depuis plus de 30 jours = à revérifier.

## Recommandation (à valider par le propriétaire)
Pour chaque application, une seule étiquette :
- **Garder** : utile, sans doublon, coût justifié.
- **À examiner** : doublon possible, utilité non démontrée ou données manquantes (liste ce qu'il faut vérifier).
- **Remplacer** : seulement avec une alternative sourcée (voir `workeda-alternatives-apps`).
- **Retirer** : seulement si l'application est confirmée, redondante et sans effet démontré ; indique le risque (perte de fonction, données, facturation) et l'ordre prudent (tester sur un thème en copie).

## Livrable
Tableau : Application | Statut | Fonction | Coût connu | Utilité | Impact mesuré | Recommandation | À vérifier. Puis : économies **possibles** (somme des coûts connus des applications « retirer ») avec la mention « hors coûts inconnus ».

## Règles
- Tu recommandes, tu n'exécutes jamais : aucune installation, désinstallation ni changement d'abonnement, aucune écriture Shopify.
- Chaque chiffre porte sa source (inventaire du jour J, mesure du jour J).
- Aucune donnée client n'est nécessaire ni demandée.
