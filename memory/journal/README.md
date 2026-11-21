# Journal de la mémoire des agents

Un fichier `<appareil>.jsonl` par ordinateur : chaque ligne est un changement de souvenir (création, modification,
validation, archivage, suppression). Ce dossier est **suivi par git** : c'est lui qui synchronise la mémoire entre vos
ordinateurs. Au démarrage (ou avec `npm run memory:sync`), Archipel importe les lignes qu'il ne connaît pas encore.

- Ne modifiez pas ces fichiers à la main : ajoutez ou corrigez un souvenir dans le Memory Center.
- Chaque ordinateur n'écrit que dans son propre fichier, donc git ne produit pas de conflit.
- Le journal ne contient jamais de secret : ils sont refusés avant l'enregistrement.
- La base `data/workeda.db` reste locale (ignorée par git) ; les sauvegardes sont dans `data/backups/`.
