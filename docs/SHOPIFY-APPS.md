# Shopify App Manager — audit des applications de la boutique (Phase 8)

Objectif : permettre à Archipel (et à **Maxime**, 11e agent) d'identifier les applications Shopify inutiles ou redondantes, leurs coûts connus, leur impact mesuré sur le chargement et les pistes d'amélioration de la conversion, **sans rien installer, désinstaller, payer ni modifier**.

## Ce qu'Archipel sait et ne sait pas
- L'API Admin Shopify de lecture déjà préparée **ne liste pas les applications installées**. Archipel ne connaît donc que les applications que **vous déclarez**.
- Trois niveaux de preuve, toujours affichés :
  - **Déclarée** : saisie ou importée par vous (non vérifiée).
  - **Détectée** : créée depuis un indice de la détection publique ; **non confirmée**.
  - **Confirmée** : vous avez vu l'application dans votre admin Shopify (date enregistrée). Seul vous pouvez la confirmer.
- Un coût absent est **inconnu** (jamais zéro, jamais estimé). Un montant exige une devise et une périodicité. Les totaux sont par devise, sans conversion.

## Fonctionnement
1. **Inventaire** (Integration Center → « Applications Shopify ») : ajout et correction **à la main**, fiche par fiche, ou import CSV (aperçu, erreurs par ligne, confirmation ; fusion par nom, aucune fiche absente du fichier n'est supprimée).
2. **Analyse calculée** (sans IA) : doublons de fonction *possibles*, coûts mensuels/annuels connus, fiches à revérifier (plus de 30 jours), impact des applications liées à des indices.
3. **Détection publique et mesure** — **désactivée par défaut**. Pour la lancer : activer la fonction, confirmer chaque lancement, **et** autoriser le réseau réel (`ARCHIPEL_ALLOW_REAL_NETWORK=1`). Elle lit la page d'accueil publique de la boutique (`WORKEDA_SHOP_DOMAIN`, par défaut `workeda.com`), repère les ressources tierces (hôtes, extensions d'applications Shopify) sans les télécharger. Seuls les octets et la durée du téléchargement HTML sont mesurés (2 Mo, 10 s) ; l’impact de chaque application reste non mesuré. Requêtes GET sans identifiant, sans redirection suivie, HTTPS et hôtes publics seulement. Un script repéré est un **indice, jamais une preuve**. Vous pouvez lier un indice à une fiche, ou créer une fiche « détectée ».
4. **Maxime** (Catalogue) : lit l'inventaire via l'accès individuel (aucun par défaut, comme les autres intégrations), recommande garder / à examiner / remplacer / retirer et cherche des alternatives sourcées. Compétences : `workeda-audit-apps-shopify`, `workeda-impact-performance-apps`, `workeda-alternatives-apps`, `workeda-cro-ecommerce`.

## Sécurité
- Aucune route, aucun code d'installation, de désinstallation, d'abonnement, de facturation ni de mutation Shopify (vérifié par analyse statique dans les tests).
- Aucune donnée client : l'inventaire n'en contient pas ; coordonnées et secrets saisis dans les champs libres sont masqués avant stockage.
- Maxime ne reçoit les données que s'il a un accès accordé, jamais dans une tâche qui lit le web (règle existante des Comms) : la recherche d'alternatives se fait donc dans une tâche séparée, sans inventaire.
- Mémoire : ce que Maxime propose reste `pending` jusqu'à votre validation. Comms : un agent délégué ne peut pas élargir l'accès demandé.
- Routes `/api/shop-apps/*` soumises au même contrôle local/origine que le reste de l'Integration Center.

## Données locales (migration additive, rien d'existant modifié)
Tables `shop_apps`, `shop_app_scans`, `shop_apps_meta` (créées si absentes). Relevés de détection : **purgés après 30 jours** (5 conservés au plus). Fiches d'inventaire : conservées jusqu'à suppression par vous, signalées « à revérifier » après 30 jours sans mise à jour. Rien ne voyage par git.

## Limites connues
- Aucun accès réel aux applications installées ni aux abonnements : l'inventaire dépend de ce que vous saisissez.
- La détection est heuristique : une application sans script public, ou chargée après coup, n'est pas vue ; un script tiers peut venir du thème ou d'un autre service.
- Les mesures sont des **téléchargements** depuis cet ordinateur, en une passe sur le HTML seul, **sans rendu navigateur** : ni LCP, ni INP, ni CLS ; variables d'une passe à l'autre. Elles ne reflètent pas l'expérience réelle des visiteurs.
- La lecture publique contrôle les réponses DNS IPv4/IPv6 dans le lookup du socket TLS ; toute réponse privée, locale ou réservée, même mélangée à une adresse publique, est refusée. La connexion utilise directement ces adresses validées, sans seconde résolution. Les réponses compressées sont refusées si le serveur ignore la demande de contenu non compressé.
- Aucune connexion réelle (Shopify, App Store, éditeurs) n'a été testée : tout est vérifié par simulation.
- Interface vérifiée avec DOM simulé puis dans le navigateur sur une base temporaire en mémoire. Pas de test mobile exhaustif ni lecteur d’écran.

La confirmation CSV refuse un inventaire modifié depuis l’aperçu (409) : refaire un aperçu. Les coûts annuels sont additionnés en centimes avant arrondi du mensuel équivalent. La limite de 300 fiches s’applique aussi aux indices promus.

Le contexte agent est borné à 60 fiches au maximum et peut en fournir moins selon leur taille. Le nombre total et les omissions sont annoncés ; les analyses détaillées peuvent être résumées. L’inventaire complet reste visible dans Integration Center. Le montant maximal par fiche garantit un calcul sûr en centimes pour 300 abonnements mensualisés/annualisés ; les valeurs non finies ou trop grandes sont refusées.
