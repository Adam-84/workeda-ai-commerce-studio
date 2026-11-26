# Automation System — utilisation et limites

## Démarrer

Ouvrir **Automations** dans Archipel. Aucun modèle, import ou nouvelle règle n'est actif au démarrage. Désigner explicitement cet ordinateur, préparer une règle, vérifier les sources/grants dans Integration Center, regarder l'aperçu des horaires et confirmer son activation. Le serveur doit rester ouvert et le PC éveillé. Aucun service Windows, réglage global ou déploiement cloud n'est créé.

Un lancement « Exécuter une fois » ne modifie pas le calendrier. Sa confirmation mentionne l'IA si elle est demandée ; permissions, quotas et arrêt général restent applicables. Sans IA, l'exécution prépare une mission avec constats déterministes et références datées, sans lancer l'agent. Les analyses utilisent Comms et son runner existant autorisé. Le runner Codex interne et les protections PAL ne changent pas.

## Horaires et interruptions

Calendriers quotidien/hebdomadaire/mensuel en Europe/Paris, stockage UTC. L'heure absente au printemps et les jours mensuels absents sont ignorés ; l'heure répétée à l'automne ne s'exécute qu'au premier passage. Intervalles fixes de 15 minutes minimum. Date ponctuelle en ISO avec décalage/fuseau explicite.

Après interruption : au maximum le dernier créneau des dernières 24 heures, sans rafale. Première activation : pas de replay historique. Chaque créneau possède une clé durable. Les observations complètes établissent d'abord une référence ; les transitions de missions et nouvelles recommandations sont datées et dédupliquées. Les missions Automation sont exclues des sources de suivi, ce qui empêche les boucles de missions automatiques.

## Sources et consentements

Les sources demandées n'accordent jamais de permission. Chaque intégration exige le grant individuel de l'agent, revérifié avant collecte et appel IA. Catalogue public, Admin et 17TRACK peuvent être rafraîchis uniquement avec consentement automatique de la règle ET verrou réseau existant déjà autorisé. Les autres sources restent en cache. DSers Basic, CSV et inventaire d'apps restent manuels. La détection publique d'apps reste une action explicite avec sa confirmation existante ; aucune confirmation n'est injectée automatiquement.

Une source manquante ou périmée bloque l'analyse au lieu de produire une donnée fictive. Pas de source structurée native de prix concurrents ou analytics : les déclencheurs correspondants sont représentés mais indisponibles sans cette source. Les modèles Sophia, Chloe et Benjamin décrivent des observations/hypothèses, sans inventer tendances mesurées, conversion ou ventes. Une condition de marge nécessite prix strictement positif, SKU unique correspondant, coût unitaire connu et même devise ; elle représente les coûts connus, pas une marge nette complète. Les indices de scripts ne deviennent pas des mesures de performance.

Une alerte de péremption utilise uniquement les dates et prépare une mission sans IA ; après rafraîchissement autorisé, elle réévalue son seuil. La variation des prix de votre catalogue Admin compare deux relevés frais de même devise ; la référence de prix expire au plus tard après sept jours. Un nouveau prix zéro constitue une baisse réelle ; un ancien prix zéro ne permet pas de calculer un pourcentage.

Les dix modèles sont des définitions inactives, sans grant et sans autorisation IA implicite. Ils peuvent être adaptés avant activation.

## IA, quotas et réutilisation

Autorisation IA distincte pour chaque révision. Maximum un appel par occurrence, un travail IA Automation actif, cinq appels/jour/règle et vingt réservations/jour Automation, en plus des plafonds Comms existants. Les délégations et outils web sont désactivés pour ces tâches ; collecter les données séparément évite qu'une page web voie les données privées. Une révision modifiée désactive la règle et révoque ses consentements.

Les budgets USD et tokens sont fondés sur la consommation rapportée. Ils bloquent les appels suivants ; ils ne garantissent pas une coupure financière au milieu d'un appel. Une consommation antérieure inconnue interdit de nouveaux appels de cette règle pour la journée. Les réservations échouées restent comptées pour éviter de dépasser le plafond en cas de crash. Aucun fallback vers une API payante. Un résultat récent, vérifié et issu des mêmes révisions de données/politique est réutilisé avant de réserver un nouvel appel.

Indisponibilité/échec d'appel : suspension IA et résultat incertain, sans relance automatique. Vérifier la mission Comms ; le bouton de reprise IA réexamine les attentes non expirées, sans relancer un résultat incertain. Après examen humain, un lancement unique confirmé crée une nouvelle occurrence. Memory reste en proposition pending jusqu'à validation humaine. Tout changement Shopify, installation/désinstallation, dépense ou action sensible demeure hors des primitives Automation.

## Arrêt général

« Suspendre tout » persiste après redémarrage et interdit les nouveaux lancements, y compris manuels. Les tâches non engagées sont annulées. Une collecte déjà engagée peut terminer sa requête mais ne lance aucune analyse ensuite. Un appel IA déjà engagé termine normalement ; son état reste visible et sera réconcilié dans l'historique. Les missions manuelles Comms restent indépendantes. Reprendre un calendrier ne rejoue pas ses occurrences annulées.

## Plusieurs PC, Git et restauration

Exporter uniquement les définitions JSON, éventuellement les versionner dans Git. Importer les définitions depuis Automation Center : elles restent inactives, même si le document contient un champ d'activation. Les exécutions, droits, consentements et secrets ne sont pas exportés. Les tâches Automation sont locales et ne deviennent pas des tâches Comms ordinaires lors d'une synchronisation.

L'autorité locale utilise `data/automation-executor.local.json`, exclu de Git, et l'identité de la machine. Une copie de base sans ce fichier ne s'exécute pas automatiquement. Pour changer de PC : désactiver l'ancien, exporter/importer les définitions, désigner le nouveau et confirmer les règles voulues. Ne pas copier le jeton local pour transférer une autorité. Une restauration sur la même installation peut conserver le jeton : suspendre puis revoir les règles avant restauration.

Git ne fournit pas de verrou distribué. Deux machines clonées/activées indépendamment hors ligne ne peuvent pas garantir une exécution mondiale unique. Un ancien PC inaccessible doit être considéré comme potentiellement actif. Une autorité cloud centrale serait nécessaire pour cette garantie ; elle n'est pas déployée dans cette phase.

## Persistance et diagnostic

SQLite : schéma Automation version 1, migration Comms version 4 additive, sauvegardes existantes avant migration de bases remplies. Claims transactionnels, baux renouvelés, liaison occurrence/mission/tâche dans une transaction commune. Après crash, les étapes déterministes ont au maximum deux tentatives ; un appel IA au résultat inconnu attend une décision humaine.

L'historique est paginé, avec état, motif, tentatives, lien mission et hash d'entrées. Coûts/tokens absents restent inconnus. Les métadonnées détaillées sont purgées après 90 jours ; les clés minimales d'occurrence restent pour prévenir le replay. Les données sources conservent leur rétention existante, sans copie brute dans le journal Automation.

Tests : `npm test` et `npm run skills:check`. Tous les nouveaux tests utilisent horloges/services ou IA simulés ; aucun compte réel ni Shopify n'est nécessaire.
