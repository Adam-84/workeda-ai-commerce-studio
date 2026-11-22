# Integration Center — DSers et 17TRACK en lecture seule (Phase 6)

**État actuel : DSers Basic bloqué par défaut, imports CSV locaux disponibles, Shopify Admin préparé mais non connecté.** Voir la section « Préparation Basic, import manuel et Shopify Admin » pour les nouveaux états, la rétention et les accords requis. Les validations ci-dessous sont historiques et complétées par `docs/PR-PHASE-6.md`.

Archipel lit des données fournisseurs (DSers) et logistiques (17TRACK) pour que les agents travaillent sur du réel.
**Il ne modifie jamais DSers, 17TRACK ni Shopify.** Rien n'est contacté tant que vous ne l'avez pas décidé.

## État au moment de la livraison

- Tout est construit et testé **hors ligne** contre des serveurs simulés (aucun compte réel contacté, aucune authentification lancée).
- Le réseau réel est **verrouillé** : il faut démarrer le serveur avec `ARCHIPEL_ALLOW_REAL_NETWORK=1` (votre accord explicite) pour qu'une connexion soit possible.
- Aucun accès agent par défaut. Aucune clé, aucun jeton, aucun numéro de suivi enregistré.

## Méthodes de connexion

| Service | Méthode | Coût / blocage connu |
|---|---|---|
| DSers | MCP officiel `https://ai.dsers.com/mcp`, OAuth 2.1 + PKCE (S256), client public enregistré dynamiquement, **aucune clé d'API**. Redirection `http://127.0.0.1:4318/api/integrations/dsers/callback`. | Inclus dans les plans **Advanced, Pro, Enterprise** ; absent du plan **Basic** (l'état devient « Indisponible » avec l'explication, aucun achat). Quota DSers partagé avec vos autres clients MCP (500 / 1 250 / 12 500 appels par jour). |
| 17TRACK | API v2.4 `https://api.17track.net/track/v2.4`, en-tête `17token`. Archipel n'accepte qu'une **clé déjà existante** que vous collez. | Compte développeur 17TRACK requis (Archipel n'en crée pas, n'active aucun essai). `register` consomme du quota payant : **interdit**. Liste blanche d'IP possible côté 17TRACK. |

Portées DSers demandées (exactement, vérifiées dans les métadonnées publiques) : `store:read supplier:read product:read order:read tracking:read plan:read`.
Jamais : `billing:read`, `staff:read`, réglages, thème, `product:mapping` ni aucune portée d'écriture. Si le service accorde une portée de plus, la connexion est refusée et les jetons supprimés.

## Permissions (appliquées côté serveur, avant tout réseau)

- **DSers** : 12 outils de lecture autorisés (`get_plan_and_credits`, `list_stores`, `list_managed_store_products`, `get_managed_store_product`, `search_store_products`, `get_supplier_product`, `list_supplier_product_shipping_methods_and_cost`, `list_platform_shipping_methods`, `list_supplier_product_change_notifications`, `get_pricing_rule`, `list_packages`, `get_package_details`). Les 26 outils d'écriture/commande/paiement/publication/suppression et 22 outils de lecture inutiles sont refusés ; tout outil inconnu l'est aussi (refus par défaut).
- **17TRACK** : seulement `getquota`, `gettracklist`, `gettrackinfo`.
- Aucun agent n'appelle ces services : il reçoit un **bloc de données** préparé par Archipel, depuis des relevés déjà en cache.

## Quota, cache, erreurs

- DSers : **100 appels/jour par défaut**, configurable (Integration Center, ou `ARCHIPEL_DSERS_DAILY_CAP`, max 2 000). 17TRACK : 300/jour. Atteint = refus local, aucun appel réseau.
- Cache par type de relevé ; une tâche **ne déclenche jamais** de relevé (elle ne consomme pas le quota).
- Un seul appel à la fois par connecteur ; opérations identiques simultanées mutualisées ; 17TRACK limité à 3 requêtes/s et 40 numéros/requête.
- `429` / `RATE_LIMITED` : pause enregistrée et respectée (`Retry-After`). Délais, taille de réponse et redirections bornés. Les messages d'erreur distants ne sont jamais recopiés.

## Confidentialité

- Les agents ne reçoivent **aucun** nom, adresse, e-mail ni téléphone de client. Projection par **liste blanche** (jamais par liste noire) : pas de texte libre d'événement, destination réduite au pays, transporteur issu d'un vocabulaire fermé, référence de commande = numérotation Shopify (`#1042`) sinon identifiant opaque.
- Numéros de suivi **masqués** (`RR*********CN`) avec identifiant stable non réversible.
- Les blocs sont présentés comme **données non fiables**, datés, avec troncature annoncée et sources `archipel://integrations/<service>/<id>` vérifiables.
- Provenance : un résultat issu de données DSers/17TRACK n'est transmis qu'à une tâche qui a la même demande, l'accès accordé et **aucune recherche web** ; il reste **hors du journal git**. Une délégation découlant de ces données est refusée vers un agent sans accès.

## Sécurité des secrets

- Windows : **DPAPI** (le secret transite par l'entrée standard, jamais par la ligne de commande). Linux/cloud : AES-256-GCM avec `ARCHIPEL_SECRET_KEY` (≥ 32 caractères). Sans protecteur : stockage **indisponible**, jamais de repli en clair.
- Fichiers dans `data/secrets/` (ignoré par git). Jamais synchronisés : chaque ordinateur se connecte lui-même.
- Révoquer = supprimer les jetons locaux (DSers n'a pas de point de révocation : retirez aussi Archipel dans votre compte DSers). Un retour OAuth ou un renouvellement en cours ne peut pas rétablir une connexion révoquée.

## Utilisation

1. Bouton **Integrations** → carte du service : états réels *Non configuré / Configuré / Authentifié / Testé / Indisponible*, permissions, quota, dernier test et dernière synchronisation, erreurs.
2. DSers : **Se connecter** (confirmation, nouvel onglet DSers) → **Tester** → **Actualiser**.
3. 17TRACK : coller une clé existante → **Tester** → **Actualiser** (relève seulement les suivis déjà enregistrés dans votre compte).
4. **Accorder la lecture** agent par agent (suggestions : Lucas = rapprochement Shopify↔DSers, Isabella = coûts/marges, Benjamin = logistique, Alexander = synthèse ; *aucune n'est appliquée seule*).
5. Dans **Comms → Déléguer**, cocher « Fournir les données DSers / 17TRACK ». L'accès est revérifié à l'exécution.

## Plan de mise en œuvre réalisé

`secret-store` → `integrations-core` (liste blanche, PII, rapprochement, logistique) → `mcp-client` + `oauth-pkce` → `dsers-connector` / `track17-connector` → `studio-integrations` (état, accès, quota) → `integrations` (service) → routes `/api/integrations/*` (réservées à cette machine) → migration comm v3 (`with_integrations`) → interface.

## Limites connues

- Les **noms de champs des réponses DSers** sont des hypothèses prudentes (clés candidates) : à confirmer à la première connexion réelle. Les outils réellement exposés à votre compte ne sont connus qu'après un test réel.
- Un abonnement DSers sans MCP rend la partie DSers indisponible ; 17TRACK seul reste possible si vous avez déjà une clé.
- Le quota d'essai 17TRACK est inconnu. Les numéros de suivi ne sont pas disponibles via l'API Admin Shopify (non connectée) : seulement via DSers (colis) ou des suivis déjà enregistrés chez 17TRACK.
- Du texte libre (noms de produits, libellés fournisseurs) peut en théorie contenir une donnée personnelle : la projection est par liste blanche mais ne peut pas garantir l'absence de nom dans un titre.
- Les accès agents, jetons et relevés sont **locaux à chaque PC**.
- La validation DPAPI réelle dépend de l'environnement PowerShell de l'ordinateur (testée ici sous Windows ; l'outil de revue indépendant n'a pas pu la charger dans son bac à sable).

## Durcissement final du 22 novembre 2026

- DPAPI charge explicitement le module de Windows PowerShell et utilise UTF-8 ; les erreurs du sous-processus ne sont jamais propagées avec leurs entrées/sorties. AES-GCM reste inchangé.
- Les erreurs OAuth, noms d'outils inconnus et quotas 17TRACK ne recopient plus de texte libre distant. Les réponses OAuth et 17TRACK sont limitées à 2 Mo, comme MCP.
- Une révocation invalide les opérations en cours et en attente. Un refus d'authentification retire le drapeau « authentifié ». Le plafond DSers de 2 000 s'applique aussi à la configuration par environnement.
- Les devis forcés sont relus ; un changement de pays ou un cache expiré invalide les devis précédents. La limite de 15 produits par lot reste appliquée.
- Observations, libellés de références, erreurs d'exécution et détails d'accusés liés aux intégrations restent hors du journal portable. Les événements de messages utilisent un libellé neutre.
- Les consignes déléguées et métadonnées de sous-mission ne sont plus relues hors de leur contexte d'accès. Les tâches demandant une intégration ne proposent pas de mémoire générale, qui ne conserve pas cette provenance.
- Le rafraîchissement automatique du panneau respecte la navigation au clavier ; une action restaure le focus et conserve son message de résultat réel.

Les régressions sont exécutées contre les simulateurs et des réponses HTTP en mémoire, sans compte ni appel réseau externe. La vérification UI automatisée porte sur le contrôleur (focus et annonces) ; aucun audit avec lecteur d'écran réel n'a été effectué. La limite des champs libres de catalogue et les hypothèses de format DSers restent celles décrites ci-dessus.

Validation finale : Node 24.13.1, tests ciblés **159/159**, suite `node --test` **430/430** (416 existants + 14 régressions), aucun échec ni test ignoré. `git diff --check` sans erreur ; fichiers modifiés en CRLF. Aucun commit ni push.


## Champs libres du catalogue — complément du 22 novembre 2026

- `catalog-privacy.js` neutralise uniquement les e-mails, téléphones et formats usuels de suivi (S10, UPS, préfixes alphabétiques et longues suites numériques), y compris les encodages HTML/URL courants. Noms, adresses, texte commercial, caractéristiques et dates restent conservés ; ce filtre ne constitue pas une anonymisation générale.
- Shopify public/Admin : nettoyage des titres, descriptions, tags, fournisseurs, types, handles, titres SEO et URL avant troncature et stockage des nouveaux relevés. Les collections sont couvertes aussi. Les anciens `shop_snapshots` sont filtrés à la lecture et par `catalogPrompt`, sans réécriture des anciennes lignes SQL.
- Le rapprochement conserve les identifiants Shopify et nettoie ses champs libres. Un handle sensible ou déjà neutralisé ne sert pas de clé de rapprochement : aucun lien artificiel entre deux marqueurs identiques. La correspondance exacte par identifiant reste possible.
- Les blocs d’intégrations, les appels agent de Comms et le contexte mémoire filtrent aussi les anciennes données. Les journaux portables Comms/mémoire (y compris sources, observations et métadonnées textuelles imbriquées) et les nouveaux événements d’activité neutralisent ces coordonnées avant sérialisation ou troncature. Les bases locales et les journaux historiques ne sont pas purgés rétroactivement.
- Les listes blanches DSers/17TRACK restent fermées. Les variantes de noms, chemins, casse, suffixes et objets coercibles sont refusés ; le refus ne recopie plus le nom libre fourni.
- Contrôle du contenu des fichiers suivis avec `git ls-files` et expressions régulières : aucune donnée client réelle ni secret exploitable identifié ; coordonnées restantes dans des fixtures explicitement fictives ou adresses techniques. Six fichiers de tests contenant d’anciens faux jetons littéraux ont été convertis en assemblages à l’exécution. Le contrôle est heuristique et ne couvre pas l’historique Git.

Validation de ce complément : **9 régressions**, tests ciblés **223/223**, suite `node --test` **439/439**, aucun échec ni test ignoré. Simulateurs et réponses en mémoire uniquement. Aucun réseau externe, compte réel, commit ou push.


## Préparation Basic, import manuel et Shopify Admin — 22 novembre 2026

Cette section remplace les indications précédentes sur la connexion Basic et sur le catalogue Admin activé par un simple jeton. Aucun compte réel n’a été contacté.

### DSers Basic et états réels

Le réglage **local** « plan DSers » propose inconnu (`unknown`), Basic, Advanced, Pro, Enterprise ; **Basic par défaut**. L’état exact est **Indisponible — abonnement Basic**. Les entrées OAuth (y compris callback et renouvellement), test, synchronisation, appel d’outil et transport refusent Basic avant réseau et création de secret. Passer à Basic invalide les opérations en cours et supprime les secrets DSers locaux ; changer de déclaration ne prouve jamais l’éligibilité du compte. Le refus distant des plans payants déclarés reste appliqué.

Les cartes distinguent **DSers direct**, **Shopify public**, **Shopify Admin**, **Import manuel — origine déclarée DSers** et 17TRACK. Public devient **Disponible** après un relevé réussi ; Admin reste **À configurer** sans accord/configuration/autorisation réseau, puis **Configuré — non vérifié**, et **Authentifié** après une réponse Admin valide et la vérification des droits. 17TRACK reste **Non connecté** sans clé ; son fonctionnement est inchangé.

### CSV Archipel et absence d’adaptateur DSers vérifié

Télécharger le modèle dans l’Integration Center, le remplir, choisir le fichier local, **Valider et prévisualiser**, puis **Confirmer l’import**. Aucun format d’export DSers Basic n’a été vérifié : le choix « Export DSers » est refusé avec une explication ; aucun en-tête officiel n’est supposé.

Contrat **Archipel v1**, UTF-8 avec BOM facultatif, séparateur `;` ou `,`, guillemets doublés et retours en cellule supportés :

`id;sku;order_id;date;quantity;currency;cost_kind;purchase_cost;shipping_cost;carrier;status;tracking_number`

- Une colonne parmi `id`, `sku`, `order_id` est requise. Les autres sont facultatives ; en-têtes clients et inconnus supprimés, doublons ou en-têtes vides refusés. Chaque ligne doit comporter une référence. Les identifiants produits numériques/GID sont conservés ; les références de commande libres deviennent opaques.
- Limites : **500 × 1 024 octets**, **5 000 lignes de données**, **40 colonnes**, **2 000 caractères par cellule**. Les formules des colonnes retenues sont refusées, jamais évaluées. Les erreurs ne recopient pas les valeurs brutes.
- Dates ISO (`AAAA-MM-JJ` ou date UTC), quantité entière positive, montants positifs ou zéro explicite avec deux décimales maximum ; `currency` ISO 4217 ; `cost_kind` = `purchase_unit` ou `purchase_total`. Un coût renseigné exige devise et nature. Les coûts absents restent `null`, avec motif `absent` ; aucun calcul de marge automatique n’est ajouté.
- Aperçu projeté/nettoyé : e-mails, téléphones et formes de secrets reconnues neutralisés ; suivis masqués et clé stable de rapprochement. Colonnes clients supprimées avant stockage. Le brut n’est jamais persisté. Le serveur conserve **un seul aperçu nettoyé**, isolé du retour API, pendant **10 minutes** ; toute nouvelle validation remplace cet aperçu.
- Une seule erreur empêche tout le lot ; la confirmation utilise l’identifiant de l’aperçu serveur, puis une transaction atomique. Un nouvel import devient le lot courant (au plus cinq versions locales conservées dans la limite de rétention). La prévisualisation UI affiche 20 lignes ; les blocs agent affichent au plus 30 lignes par type et annoncent leur caractère partiel.
- Source `manual_import`, origine déclarée par le propriétaire ; un fichier rempli manuellement n’est pas attesté par DSers et ne rend jamais MCP authentifié.

### Conservation et accès

Imports : **30 jours maximum** ; caches Shopify publics et Admin, y compris anciens relevés : **7 jours maximum**. Purge à l’ouverture, aux lectures concernées et chaque minute pendant le fonctionnement du Studio. La suppression est logique dans la base locale ; aucun effacement physique de SQLite ou des sauvegardes n’est promis. Le propriétaire peut supprimer imports/cache Admin et retirer les accès depuis les cartes.

Aucun accès agent par défaut. Permissions individuelles `manual_import` et `shopify_admin` dans l’Integration Center ; sélection explicite dans Comms. Seuls les caches sont transmis, sous bloc de données non fiables, daté et accompagné de sources `archipel://integrations/<source>/<uuid>`. Les demandes marquées web ne reçoivent pas ces sources. Délégations et résultats conservent la restriction de provenance ; contenu, observations, erreurs et sources restent hors journal portable. Les propositions de mémoire générale sont désactivées pour ces tâches, faute de mémoire conservant cette restriction. Les dix agents et leurs fiches restent inchangés ; les journaux synchronisent les demandes et états, jamais les imports, consentements, accès ou jetons.

### Shopify Admin préparé, sans connexion réelle

Le jeton reste fourni uniquement par environnement (`SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_ADMIN_DOMAIN`). Sa présence **ne sélectionne plus automatiquement Admin** : le catalogue existant et `ensureFresh()` restent publics. Admin nécessite un accord local daté enregistré avec confirmation dans l’Integration Center, lié au domaine exact, **et** le verrou réseau serveur déjà décrit. Retirer/modifier l’accord invalide les relevés en cours et purge le cache Admin. Au redémarrage, une ancienne authentification redevient non vérifiée.

- API fixe **2026-10**, refus si `X-Shopify-API-Version` est absent ou différent. Toutes les requêtes Admin passent par `networkGate`, y compris avec un transport injecté pour les tests ; celui-ci n’est exposé par aucune route/configuration. Les tests utilisent uniquement des objets d’environnement isolés et des transports simulés, sans modifier l’environnement du processus.
- Vérification `currentAppInstallation.accessScopes` avant lecture : **read_products + read_inventory**. **read_orders** est une capacité autorisée séparément par case à cocher ; fenêtre filtrée et vérifiée localement à **60 jours maximum**. Aucune demande de `read_customers`, `read_all_orders` ni `write_*`.
- Requêtes GraphQL fixes sans mutation ; catalogue et variantes projetés, prix, stocks `available` par emplacement. Commandes : ID opaque, dates, statut de traitement, fulfillments et transporteur normalisé/suivi masqué. Jamais de customer, adresses de livraison/facturation, e-mail, téléphone, notes, customAttributes, metafields ou URL de suivi. Les champs commerciaux du catalogue restent nettoyés selon les règles précédentes.
- Erreurs GraphQL même en HTTP 200, réponses bornées, refus des redirections, pause 429. Jusqu’à quatre pages de 50 produits/commandes ; 50 variantes/produit, 20 emplacements, 50 traitements/commande et 20 suivis/traitement. Les limites atteintes sont signalées comme partielles. Caches publics et Admin séparés ; aucune tâche Comms ne lance de relevé Admin.

### Validation de cette préparation

Tests et revue exclusivement sur réponses en mémoire et serveurs locaux simulés ; aucun compte, appel fournisseur réel, nouvelle permission réelle, commit, push ou fusion. Résultats chiffrés dans `docs/PR-PHASE-6.md`. Restent non vérifiés : formats DSers Basic et compatibilité avec un compte Shopify réel ; lecteur d’écran réel non testé. Les filtres de coordonnées/secrets restent heuristiques.
