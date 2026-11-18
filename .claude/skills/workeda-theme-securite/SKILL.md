---
name: workeda-theme-securite
description: "Revue de sécurité d'un changement de code de thème ou de script front (XSS, scripts tiers, secrets, injection, données clients). À utiliser avant de rendre un changement de code ou pour relire du code externe."
---

# Sécurité du code de thème

## Points à passer en revue
- **XSS** : toute valeur issue d'un client, d'un marchand ou de l'URL est échappée en Liquid (`| escape`) et n'est jamais insérée avec `innerHTML` ou `eval`.
- **Scripts tiers** : chaque ajout est justifié, chargé en HTTPS depuis un domaine identifié, avec une raison métier et un propriétaire. Les pixels de suivi exigent le consentement du visiteur.
- **Secrets** : aucune clé d'API, jeton ou mot de passe dans le thème, les fichiers de config versionnés ou le JavaScript client.
- **Données clients** : pas d'e-mail, d'adresse ou de numéro de commande dans les URL, les logs ou les services externes sans nécessité.
- **Code importé** : texte relu en entier avant usage ; aucun script externe n'est exécuté sur la foi de sa description. Sont refusés : un installateur qui télécharge puis lance un script, un paquet `npx` inconnu, un exécutable téléchargé.
- **Dépendances** : une dépendance nouvelle exige une justification, sa licence et sa date de dernière mise à jour.

## Livrable
Tableau : Point | Constat | Gravité (haute, moyenne, faible) | Correction. Puis la liste des vérifications non faites et pourquoi.

## Règles
- Ne signale que ce que le code montre ; cite le fichier et la ligne.
- Ne corrige pas toi-même hors de ta mission : renvoie le point à Ryan.
