---
name: workeda-impact-performance-apps
description: "Interpréter les mesures réelles de chargement de la boutique Workeda (scripts tiers, octets, durées, ressources bloquantes) et relier prudemment ces mesures aux applications déclarées. À utiliser pour évaluer l'impact des applications sur la vitesse."
---

# Impact des applications sur les performances

## Ce que valent les mesures
- Les mesures fournies par Archipel sont **réelles** mais limitées : une passe depuis un ordinateur, HTML et ressources tierces téléchargés, **sans rendu navigateur**. Elles ne donnent ni LCP, ni INP, ni CLS.
- Les durées varient d'une passe à l'autre : une seule mesure n'est pas une preuve ; recommande de la répéter à des moments différents avant de trancher.
- Un script détecté est un **indice**. Il n'est jamais la preuve qu'une application précise est installée ; le lien avec une application n'existe que si le propriétaire l'a établi.
- Le nombre de scripts seul ne mesure rien : raisonne sur les octets, les durées et le caractère bloquant au rendu.

## Lecture
1. Totaux tiers : requêtes, octets, durée cumulée, ressources bloquantes, échecs.
2. Par indice : octets, durée, nombre de scripts bloquants ; classe du plus lourd au plus léger.
3. Par application liée : somme des mesures de ses indices ; sans lien ou sans mesure : « impact non mesuré ».
4. Compare au bénéfice commercial déclaré : une application lourde mais qui rapporte peut rester utile ; une application lourde sans bénéfice démontré est un candidat à l'examen.

## Livrable
Tableau : Indice ou application | Octets | Durée | Bloquants | Lien établi ? | Lecture prudente. Puis 3 actions possibles (différer le chargement, retirer un doublon, remplacer par une fonction native du thème) marquées « à valider et à tester sur une copie du thème ».

## Règles
- Ne présente aucune mesure comme une performance réelle de visiteurs ; ce sont des mesures de téléchargement.
- Aucune modification du thème ou de la boutique : propositions seulement.
- Donnée absente = « non mesuré ».
