---
name: workeda-liquid-theme
description: "Modifier proprement un thème Shopify (Liquid, CSS, JavaScript) dans une copie locale : structure du thème, sections et schéma, accessibilité, performance, vérification par theme check. À utiliser pour tout changement de code de thème."
---

# Développement de thème Shopify

## Avant de coder
1. Lis les fichiers concernés et le code voisin ; respecte les conventions existantes (nommage, indentation, classes CSS).
2. Travaille uniquement dans la **copie locale** du thème. Le thème publié n'est jamais touché.
3. Fais le plus petit changement qui répond à la demande.

## Repères Liquid
- `sections/` : blocs de page configurables, avec un `{% schema %}` JSON valide (réglages, blocs, valeurs par défaut).
- `snippets/` : morceaux réutilisables, appelés par `{% render 'nom' %}` (pas `include`, déprécié).
- `blocks/`, `templates/`, `layout/`, `assets/`, `locales/`, `config/` : respecte leur rôle.
- Textes visibles : passe par les fichiers de langue (`{{ 'cle' | t }}`), pas de texte français écrit en dur si le thème est traduit.
- Images : `image_url` et `image_tag` avec largeurs, `loading="lazy"` sous la ligne de flottaison, `alt` renseigné.
- Échappe les valeurs saisies par les clients ou les marchands (`| escape`) ; n'injecte jamais de données non maîtrisées dans du JavaScript.

## CSS et JavaScript
- CSS : mobile d'abord, variables existantes avant d'en créer, pas de `!important` sauf nécessité expliquée.
- JavaScript : sans dépendance nouvelle, sans bloquer le rendu (`defer`), avec gestion du clavier et des lecteurs d'écran pour les composants interactifs.

## Vérifier avant de rendre
- Lance `shopify theme check` sur la copie locale et rapporte le résultat tel quel.
- Décris les fichiers modifiés et pourquoi ; Harper contrôle ensuite.

## Interdit
Toute commande qui envoie, publie, supprime ou partage un thème sur la boutique : propose-la à l'humain, ne la lance pas.
