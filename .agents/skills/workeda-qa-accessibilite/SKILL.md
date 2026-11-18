---
name: workeda-qa-accessibilite
description: "Vérifier l'accessibilité et la qualité d'une page ou d'un thème selon WCAG 2.2 AA (clavier, contrastes, libellés, formulaires, mobile), avec preuves, et préparer des scénarios de test Playwright. À utiliser pour une recette d'interface."
---

# QA et accessibilité

## Contrôles (WCAG 2.2 AA)
- **Clavier** : tout élément interactif s'atteint et s'active au clavier, l'ordre de tabulation est logique, le focus est visible, aucun piège au clavier.
- **Contrastes** : texte courant à 4,5:1 minimum, grand texte et composants d'interface à 3:1. Calcule le rapport sur les couleurs réelles du CSS.
- **Alternatives** : images informatives avec `alt` pertinent, images décoratives avec `alt=""`.
- **Structure** : un seul `h1`, titres hiérarchisés, repères (`header`, `nav`, `main`, `footer`), langue de la page déclarée.
- **Formulaires** : chaque champ a un libellé associé, les erreurs sont écrites et reliées au champ, aucune information transmise par la couleur seule.
- **Zones tactiles et zoom** : cibles d'au moins 24 px, page utilisable à 200 % de zoom et à 320 px de large sans perte.
- **Mouvement** : animations respectant `prefers-reduced-motion`.

## Tests automatisés
Un scénario Playwright décrit : parcours, action, résultat attendu vérifiable. Écris-le en texte pour que l'humain le lance ; tu n'exécutes que les commandes autorisées par ta fiche.

## Preuves
Extrait de code avec chemin, valeur calculée, sortie de commande. Une capture n'est une preuve que si l'utilisateur la fournit. Un lecteur d'écran réel n'a pas été utilisé : dis-le.

## Livrable
Tableau Critère | Résultat | Preuve | Correction proposée, et la liste de ce qui n'a pas pu être vérifié.
