# Phase 8 — reprise et vérification par Codex

Date : 25 novembre 2026. Branche : `feat/shopify-app-manager`.

## État retrouvé

Le dépôt réel est dans le projet VSCODE `workeda-ai-commerce-studio`. Le dossier ChatGPT initial était vide. L’accès au dépôt a été autorisé par le mécanisme normal de la session, sans changement de permissions globales ni contournement PAL.

La branche était propre, alignée sur sa branche distante et portait déjà `3a0243c` (« Shopify App Manager et agent Maxime »), directement après `8f9f477`. Cette reprise n’a créé aucun commit et n’a effectué aucun push ni fusion.

L’implémentation existante apporte Maxime (Catalogue), les trois nouveaux skills et la réutilisation de CRO e-commerce, l’intégration locale `shopify_apps`, l’inventaire manuel et CSV, les statuts de provenance, les coûts connus, les doublons fonctionnels et les accès individuels via Integration Center et Comms. Les tables sont additives. Les relevés sont purgés après 30 jours ; les fiches restent conservées et deviennent à revérifier. Les dix fiches d’agents antérieures sont inchangées par rapport à `8f9f477`.

## Corrections apportées

- Coûts : addition des coûts annuels en centimes avant calcul du mensuel équivalent. Deux abonnements annuels à 10 EUR donnent 20 EUR/an et 1,67 EUR/mois, au lieu de 19,92 EUR/an et 1,66 EUR/mois.
- Import : un aperçu capture la révision de l’inventaire. Une correction après aperçu entraîne un refus 409 à la confirmation, sans écraser la correction. Il faut refaire l’aperçu.
- Inventaire : la limite de 300 applications s’applique aussi à la création depuis un indice.
- Détection : suppression des téléchargements de ressources tierces. Une seule requête GET HTTPS vers la page d’accueil du domaine configuré, sans redirection suivie ni identifiants. Le contenu HTML ne peut plus ajouter de destinations réseau. La détection reste désactivée par défaut et requiert activation, confirmation à chaque lancement et autorisation réseau explicite.
- Mesures : taille et durée du téléchargement HTML seulement. Les scripts tiers restent des indices ; leur poids, durée et impact par application sont non mesurés, jamais remplacés par zéro. Interface, documentation et skill de performance (source et copies gérées) alignés.

## Vérifications exécutées

- Référence `8f9f477`, exportée dans une copie temporaire : **474 tests réussis, 0 échec, 0 ignoré**. Une première exécution de l’archive sans métadonnées Git avait échoué uniquement sur `git check-ignore` ; après initialisation Git de cette copie temporaire, la suite entière passe.
- Branche actuelle : **492 tests réussis, 0 échec, 0 ignoré**, dont quatre nouveaux tests de régression. Ces quatre tests échouaient sur le code antérieur pour les raisons attendues, puis passent après correction.
- Vérification des skills : **22 skills, 11 fiches, tout est cohérent**.
- `git diff --check` : aucune erreur de format.
- Aucun changement dans `.github` ou `tools` par rapport à `8f9f477`. Aucun réglage global, protection PAL ou runner Codex modifié. Les autorisations réseau réelles n’ont pas été activées pendant cette reprise.

## Limites avant commit

- Aucun compte réel contacté, aucune mutation Shopify, installation, désinstallation, modification d’abonnement ou dépense. Les intégrations sont vérifiées par simulateurs et les appels HTTP de tests visent des serveurs locaux.
- L’inventaire dépend des déclarations du propriétaire ; l’API Admin utilisée ne prouve pas les applications installées ni leurs abonnements.
- La lecture HTML ne mesure ni LCP, ni INP, ni CLS, ni l’expérience réelle des visiteurs ou l’impact de chaque application. La détection peut manquer les scripts chargés dynamiquement et les applications sans script.
- Le contrôle DNS et les réponses compressées ont été renforcés dans la finalisation ci-dessous ; la détection reste désactivée.
- Vérification en navigateur effectuée sur une instance temporaire en mémoire, avec données fictives et réseau externe bloqué. Aucun test mobile exhaustif ni test lecteur d’écran. Voir le complément ci-dessous.
- Aucun agent réel n’a été lancé : ni validation d’une réponse réelle de Maxime, ni invocation du runner Codex d’Archipel.

Les corrections restent dans l’arbre de travail pour revue, avant toute décision de commit, push ou fusion.


## Complément — vérification navigateur et circuit de Maxime

Vérification du 25 novembre 2026 dans le navigateur intégré, avec la véritable interface et une base en mémoire séparée. Aucun compte ni donnée de production utilisé. Le lanceur d’agent réel était remplacé par un refus explicite, les connecteurs détectés étaient simulés absents et le réseau externe bloqué.

Parcours observés :

- Inventaire initial vide ; détection désactivée, bouton de lancement bloqué.
- Ajout d’une fiche à 10 EUR/an, puis d’une fiche sans coût : coût inconnu et doublon fonctionnel signalés.
- Correction d’une note sans perdre le coût annuel ; changement de statut fictif visible dans les compteurs.
- CSV invalide sans devise refusé avec erreur de ligne, sans bouton de confirmation.
- CSV valide prévisualisé sans modification de l’inventaire, puis importé : une fiche ajoutée, une mise à jour et conservation de la fiche absente du fichier. Total final : 20 EUR/an, 1,67 EUR/mois ; coût de la troisième fiche inconnu.
- Accès Applications Shopify attribué à Maxime seul, puis retiré ; les autres intégrations gardent leurs accès vides.
- Maxime présent dans Catalogue et sur l’archipel ; quatre skills préchargés visibles, ajout d’un cinquième bloqué.
- Aucune erreur console relevée au terme de ces parcours.

Défaut constaté et corrigé : l’aperçu CSV n’affichait que le nombre de fiches. Il présente désormais un tableau avec ligne, nom, éditeur, fonction, statut, offre, coût/périodicité, date et note. Le test d’interface existant a été étendu : il échouait avant correction, passe après, et le tableau a ensuite été vérifié visuellement dans le navigateur.

Le vrai circuit Comms/Memory a également été exercé avec un runner entièrement simulé : refus d’inventaire sans accès, lecture individuelle après accord, coût inconnu conservé dans le contexte, aucun outil réseau lors de la lecture d’inventaire, inventaire exclu d’une tâche web, aucun accès implicite pour Lucas. Une proposition mémoire dans une tâche sans intégration reste `pending` malgré une demande `active` dans la réponse simulée ; aucune mémoire active n’est créée. Les réponses aux tâches d’intégration ne créent pas de mémoire sans provenance conservée.

Ces essais valident le circuit de contrôle, pas la qualité de recommandations d’un modèle réel. La déduplication des tâches a réutilisé le premier résultat lorsque les consignes étaient identiques ; les scénarios ont ensuite été distingués et tous leurs contrôles passent.

Après la correction d’aperçu : **492 tests réussis, 0 échec, 0 ignoré**. Aucun commit, push ou fusion effectué. Le contrôle DNS reste nécessaire avant d’envisager une détection réelle ; elle reste désactivée.


## Finalisation autorisée — revue et modèle réel

La mise à jour distante a révélé que la PR #10 avait déjà fusionné l’implémentation initiale (`3a0243c`) dans `main` (`946f401`). Les corrections ont donc été conservées sur une nouvelle branche `fix/shopify-app-manager-review` créée depuis ce `main`, sans réécriture d’historique.

Une seconde revue en lecture seule a trouvé et fait reproduire deux défauts supplémentaires : montant non fini accepté et inventaire agent tronqué silencieusement. Les montants sont maintenant bornés afin de préserver les agrégats en centimes de 300 fiches ; le contexte annonce total/omissions avant le contenu borné et garde un JSON entier. Le budget est calculé après masquage des contacts, qui peut agrandir les textes. Les indices sont réduits avant les fiches si nécessaire. La limitation du contexte à 60 fiches au plus reste explicite : un audit complet de grands inventaires nécessite les fiches omises.

La détection utilise désormais un transport HTTPS limité à la page d’accueil. Les adresses DNS IPv4/IPv6 sont contrôlées au moment de la connexion et fournies directement au socket ; toutes les réponses doivent être publiques. Pas de seconde résolution, pas de connexion mise en cache, validation TLS conservée. La requête demande `Accept-Encoding: identity` et refuse un contenu encodé si le serveur l’ignore. Les tests couvrent notamment adresses privées/locales/réservées, réponses mixtes, IPv4 encapsulée en IPv6, changement d’adresse entre deux scans et refus gzip/br. Aucun domaine Shopify n’a été contacté. La dernière revue ciblée n’a démontré aucun défaut résiduel dans les corrections DNS, compression et budget de contexte.

Un essai réel unique a été exécuté via le client Claude Code déjà installé, connecté à l’abonnement existant, avec le lanceur Archipel et une base en mémoire. L’entrée officielle Node du client a été utilisée sous Windows à la place du shim `.cmd`, avec les mêmes arguments d’isolation : aucun outil, MCP strict, aucun réglage utilisateur/projet chargé, aucune session persistée. Aucun flag de contournement, changement de réglage global ni lancement du runner Codex. Les variables de fournisseur/identifiant API auraient fait refuser l’essai ; aucune valeur de secret n’a été exposée.

Résultat : une exécution, zéro appel d’outil observé, tâche terminée. Maxime identifie les deux applications fictives d’avis à 10 EUR/mois et 120 EUR/an, calcule 20 EUR/mois et 240 EUR/an, laisse le troisième coût inconnu, distingue le doublon possible, les installations non confirmées et l’impact non mesuré, puis propose des recommandations à valider. Cela valide un cas représentatif, pas une garantie sur toutes les réponses futures. Aucun achat, installation, mutation Shopify ni compte Shopify réel contacté. Les contrôles mémoire restent vérifiés par simulation ; cet essai n’a créé aucune mémoire active.

Références techniques utilisées pour le transport : [HTTPS Node.js](https://nodejs.org/api/https.html), [résolution DNS Node.js](https://nodejs.org/api/dns.html), [plages spéciales IPv4 IANA](https://www.iana.org/assignments/iana-ipv4-special-registry/), [plages spéciales IPv6 IANA](https://www.iana.org/assignments/iana-ipv6-special-registry/).

Vérification finale après tous les correctifs : **497 tests réussis, 0 échec, 0 ignoré** ; `skills:check` confirme 22 skills et 11 fiches cohérentes ; `git diff --check` ne relève aucune erreur. Publication des corrections autorisée par le propriétaire : commit et push sur la nouvelle branche, puis PR vers main ; aucune fusion automatique.
