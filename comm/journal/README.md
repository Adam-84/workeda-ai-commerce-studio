# Journal de la communication entre agents

Un fichier `<appareil>.jsonl` par ordinateur : chaque ligne est un changement (fil, message, accusé de réception, tâche
déléguée, résultat, exécution). Ce dossier est **suivi par git** : c'est lui qui synchronise la communication entre vos
ordinateurs. Au démarrage (ou avec `npm run comm:sync`), Archipel recopie les lignes qu'il ne connaît pas encore.

- Un import **ne lance aucun agent** : il ne fait que recopier des données. Une tâche « en cours » sur un autre ordinateur
  reste affichée telle quelle ; seul cet ordinateur-là la fait avancer.
- Les agents y sont désignés par le nom de leur fiche (`sophia`), jamais par un identifiant local.
- Ne modifiez pas ces fichiers à la main. Chaque ordinateur n'écrit que dans son propre fichier : pas de conflit git.
- Le journal ne contient jamais de secret : ils sont refusés avant l'enregistrement.
- La base `data/workeda.db` reste locale (ignorée par git).
