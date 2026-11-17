# Messagerie des personnages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Remplacer le formulaire de messages par une conversation en bulles consultable intégralement, sans connecter d'IA.

**Architecture:** Ajouter une table de messages utilisateur et une lecture paginée regroupant ces messages avec les anciens échanges concernant l'agent. Conserver les routes et données inter-agents existantes. Un module de discussion gère le chargement, les brouillons et l'envoi sans reconstruire le panneau à chaque message.

**Tech Stack:** JavaScript natif, Node.js >=24, node:sqlite, HTML/CSS existants, node:test. Aucune dépendance ajoutée.

**Spec:** docs/superpowers/specs/2026-11-17-agent-messaging-design.md

## Global Constraints

- Aucun appel à un modèle ni aucune réponse simulée.
- Aucune modification de la base réelle pendant le développement ; essais sur une base temporaire.
- Conservation des anciennes tables et routes de messages.
- Aucun changement Shopify, aucune publication GitHub.
- Conservation des protections de taille serveur et des brouillons après erreur.
- Mise en œuvre après validation du document de conception.

## Review Focus

- Conversations nombreuses : l'agent est filtré avant la pagination et les échanges anciens restent accessibles.
- Dates identiques : curseur composé d'un horodatage et d'une clé unique pour éviter pertes et doublons.
- Navigation pendant un envoi : pas d'écriture dans le panneau d'un autre agent ni perte de brouillon.
- Messages longs ou contenant du HTML : texte affiché intégralement et sans interprétation.
- Téléphone et clavier : saisie, focus, défilement et bouton d'envoi restent utilisables.

### Task 1: Stockage et API de conversation

**Files:** src/studio.js, src/app.js, test/conversation-api.test.js.

**Interfaces:** GET /api/agents/:id/conversation?before=<cursor> renvoie {items, nextCursor}, en pages de 50 éléments. POST sur la même route avec {body} enregistre un message utilisateur et renvoie l'élément créé. Chaque élément porte son type d'expéditeur, le texte, l'horodatage et les identifiants nécessaires à l'affichage des anciens échanges. Le client ne peut pas prétendre envoyer au nom de l'IA.

- [x] Écrire un test HTTP avec des messages longs, plusieurs agents et plus de 500 messages ; parcourir toutes les pages et vérifier absence de fuite, de troncature, de perte ou de doublon, y compris avec des dates identiques. Vérifier que les anciens échanges sont préservés.
- [x] Observer l'échec attendu avant implémentation.
- [x] Ajouter la table utilisateur avec CREATE TABLE IF NOT EXISTS et une référence à agents ; ajouter l'insertion validée et la lecture fusionnée par curseur. Rejeter les messages vides, les types invalides, les agents absents et les curseurs invalides avec erreurs contrôlées.
- [x] Ajouter les routes paramétrées et la transmission des paramètres de recherche ; conserver les anciennes réponses API.
- [x] Vérifier les statuts HTTP pour les entrées invalides et relancer le test ciblé.

### Task 2: Panneau et interaction

**Files:** public/app.js, public/conversation.js, public/style.css ; tests au niveau navigateur si un moteur est disponible, sans faux DOM reproduisant l'implémentation.

**Interfaces:** Un composant de conversation reçoit l'agent, les noms des autres agents, les fonctions de lecture/envoi et d'annonce ; il conserve un brouillon par agent et affiche les résultats de l'API. Il reste indépendant du chargement global des échanges de la carte.

- [x] Vérifier l'interaction existante, puis établir les vérifications navigateur pour saisie >500 caractères, défilement de l'historique, envoi en échec et changement d'onglet.
- [x] Créer les bulles, l'état vide, le chargement, l'erreur avec réessai, les dates et la saisie persistante. Utiliser textContent ou des nœuds texte pour les messages.
- [x] Charger les pages précédentes en conservant la position de lecture et les éléments déjà affichés. Bloquer les envois concurrents et conserver le brouillon jusqu'au succès.
- [x] Remplacer le panneau étroit par un panneau latéral pour les personnages ; conserver le comportement des îles. Ajouter l'en-tête et les sections Discussion, Missions, Profil, Apparence, Activité.
- [x] Vérifier à 390 px et sur ordinateur, au clavier et avec longs paragraphes et URL ; vérifier les états hors ligne sans suppression du brouillon.

### Task 3: Vérification et livraison

**Files:** README.md, documents ci-dessus.

- [x] Exécuter les tests ciblés puis npm test ; examiner les éventuelles régressions.
- [x] Examiner la version rendue sur un serveur isolé avec base temporaire ; ne pas utiliser npm start sur la base réelle.
- [x] Documenter la différence entre enregistrement et réponse IA, la pagination et la protection de taille serveur.
- [x] Contrôler le diff et confirmer que la base réelle et les réglages locaux n'ont pas changé ; rapporter les limites de vérification et le fait que le portable n'est pas automatiquement mis à jour.
