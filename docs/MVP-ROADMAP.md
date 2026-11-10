# Roadmap MVP — Workeda AI Commerce Studio

## Limites de la première livraison

Le serveur local Node/SQLite est la source de vérité. Il expose uniquement les flux nécessaires à l’organisation : départements, agents, missions, messages et événements. Il n’effectue aucune connexion réseau vers Shopify, DSers ou une API de modèle.

## Schéma de sécurité

| Domaine | MVP | Étape suivante | Écriture autorisée ? |
| --- | --- | --- | --- |
| Claude/Codex | Détection de binaire | Lecture locale d’événements | Non |
| Shopify thème | Non connecté | Pull sur copie non publiée | Seulement après validation |
| GraphQL Admin | Non connecté | Lecture seule | Non au départ |
| Prix/commandes | Non connecté | Propositions validables | Jamais sans approbation |
| DSers | Non connecté | Lecture/rapprochement | À définir par validation |

## Règle des statuts

Un statut est soit manuel (configuration), soit rattaché à un événement externe vérifié. Le tableau ne doit jamais présenter une activité estimée comme un fait. Les connecteurs futurs devront stocker la source, la date, l’identifiant de session et le niveau de vérification dans `events`.

## Contrat de validation

Les missions peuvent exiger une approbation. Toute capacité de mutation Shopify devra créer un enregistrement `approvals` en attente, afficher le diff/opération à la personne, puis exiger une décision explicite avant exécution. Le serveur n’a volontairement aucun endpoint d’écriture Shopify dans ce MVP.
