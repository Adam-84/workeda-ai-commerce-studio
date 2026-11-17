# Panneau personnage et messagerie

Statut : validé par l'utilisateur le 17 novembre 2026 ; réalisé, vérifié sur une copie isolée puis appliqué au projet du fixe.

## Objectif

Au clic sur un personnage, ouvrir un panneau lisible, centré sur une discussion en bulles. L'utilisateur écrit en son nom ; cette première version conserve ses messages sans lancer de modèle IA. Le choix « Interface de messagerie d’abord » est confirmé par l'utilisateur.

## Direction proposée

- En-tête persistant : portrait du personnage, nom, métier et état réel. Aucun indicateur de présence inventé.
- Discussion ouverte par défaut. Navigation : Discussion, Missions, Profil, Apparence, Activité. La carte et les fenêtres des îles conservent leur fonctionnement.
- Panneau latéral spacieux sur ordinateur, pleine largeur sur téléphone. Zone de saisie accessible sans faire défiler toute la fiche.
- Bulles « Vous » à droite ; anciens échanges entre agents identifiés par leur expéditeur et leur destinataire. Horodatage, dates et retours à la ligne conservés. Aucun contenu interprété comme HTML.
- Saisie multiligne, bouton « Envoyer », Entrée pour envoyer, Maj+Entrée pour un retour à la ligne. Une composition au clavier IME ne déclenche pas l'envoi.
- Envoi désactivé si le message est vide ou en cours d'enregistrement. Un échec garde le texte et permet de réessayer. Un succès indique « Enregistré » et ne simule jamais de réponse.
- Brouillon conservé par agent pendant la visite, y compris en changeant d'onglet ou en fermant le panneau. Aucun stockage persistant des brouillons promis.
- Mention visible : « Messages enregistrés dans ce Studio. Les réponses IA ne sont pas encore connectées. »

## Historique et longueur

Retirer le plafond de 500 caractères dans le champ de saisie et la troncature à huit messages. Tous les messages restent consultables via « Messages précédents ». Pagination par curseur stable, filtrée par agent avant application de la pagination ; pas de plafond sur le nombre total d'échanges.

Conserver une protection serveur sur la taille d'une requête (limite actuelle d'environ 1 Mo), avec erreur compréhensible et brouillon conservé. « Sans limite » désigne ici l'absence du plafond arbitraire de saisie et de troncature de l'historique, pas une capacité matérielle infinie.

## Conservation des données

Ajouter une table dédiée aux messages utilisateur, sans réécrire les tables existantes. Les identifiants d'agents et leurs échanges existants restent inchangés. La discussion rassemble les messages utilisateur destinés à l'agent et les anciens messages entre agents le concernant, sans présenter ces derniers comme des réponses à l'utilisateur.

Les anciennes routes de messages restent compatibles pour la carte et les faisceaux. Les nouveaux messages utilisateur ne créent pas de fausses interactions entre agents.

## Approches

1. **Conserver le formulaire inter-agents et ajouter des bulles** : changement réduit, mais oblige toujours l'utilisateur à se faire passer pour un autre agent. Écarté.
2. **Discussion utilisateur par personnage, historique existant préservé** : approche recommandée, adaptée à l'usage demandé et au choix de préparer l'interface avant les réponses IA.
3. **Connecter dès maintenant les modèles IA** : hors du périmètre choisi.

## Vérification

Vérifier les messages longs, l'isolement des conversations, un historique dépassant 500 messages, les horodatages identiques, les erreurs d'envoi et le maintien du brouillon, la saisie au clavier, les petits écrans et le retour aux autres sections.

Utiliser une base temporaire pour les essais. Ne pas lancer le serveur de production, modifier la base réelle, toucher à Shopify ou publier sur GitHub. Les fichiers accessibles sont ceux du fixe ; le portable recevra le code dans une étape de synchronisation distincte.
