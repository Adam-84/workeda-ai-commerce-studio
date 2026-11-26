# Finalisation Archipel — suivi vérifiable

## Audit initial (26 novembre 2026)

Le dépôt original est sur `feat/automation-system`, HEAD `a562a513234d407ee19bfe60b95e8f79bcc5d413`. Onze fichiers suivis modifiés et dix-huit nouveaux fichiers constituent la Phase 9 non committée. Une copie Git indépendante reprend ces 29 fichiers à l'identique (SHA-256 comparés). L'original, sa base et ses secrets ne sont pas modifiés. Les données opérationnelles ne sont pas copiées.

GitHub et un fetch confirment : PR #10 et #11 fusionnées (Phase 8), PR #7 fusionnée (Watch), aucune PR ouverte et aucune branche distante Automation. Les branches `codex-runner` et `pal-hardening` existent mais divergent de main : ne pas remplacer les fichiers récents par leur ancienne version. Les onze agents et le recrutement sont conservés.

Référence reproductible : Node 24.13.1, `node --test` : **523 réussites, zéro échec, zéro skip**. Première exécution dans le bac à sable bloquée par EACCES sur le loopback ; relance autorisée avec serveurs simulés : succès. `npm audit --omit=dev` : zéro avis de vulnérabilité pour Temporal 0.5.1 et jsbi. Cela ne prouve pas l'absence de vulnérabilités dans le code.

SQLite natif Node, frontend JavaScript sans compilation, un seul paquet applicatif direct. Migrations additives, sauvegarde avant les modules Memory/Comms/Automation ; pas de migration globale versionnée pour toutes les anciennes tables. Journaux Memory/Comms prévus historiquement dans Git : uniquement leurs README sont suivis dans cet état. La cible cloud doit les déplacer hors du code.

Défaut confirmé par lecture : les routes anciennes de missions, profils et réponses IA précèdent ou évitent les gardes locales. `server.listen` n'impose pas d'adresse locale. Ajouter une barrière commune avant toute route et une écoute loopback explicite ; test HTTP de régression avant correction.

## Phase 7 : décision technique

CLI installé : 0.164.0, identique à la baseline qui échoue dans `docs/PAL-HARDENING.md` de la branche correspondante. Issue #8 ouverte : évolutions 0.165–0.171, pas une preuve d'isolation. La documentation officielle actuelle décrit sandbox, permissions et authentification, sans démontrer les critères Archipel sur ce poste :

- https://learn.chatgpt.com/docs/agent-approvals-security
- https://learn.chatgpt.com/docs/auth
- https://github.com/Adam-84/workeda-ai-commerce-studio/issues/8

Runner reporté, refus fermé, Watch conservé. Aucun CLI mis à jour, aucune authentification transférée, aucune sonde utilisant le vrai profil relancée. Reprendre les sondes existantes dans un environnement dédié seulement lorsque les préconditions changent. Claude conserve son chemin existant. Le contrat fournisseur déjà présent sur `pal-hardening` est la référence à réutiliser ; pas de nouveaux noms de modèles inventés.

## Plan et choix de conception

Le propriétaire autorise les décisions techniques courantes et demande de poursuivre sans validation intermédiaire. Les choix suivants sont des décisions de mise en œuvre, pas une autorisation de production.

1. Fiabiliser la Phase 9, corriger les défauts reproduits, documenter les limites, tester, commit et PR sans fusion.
2. Branche cloud séparée à partir de cette base vérifiée : garder SQLite sur disque local d'un serveur unique et centraliser les accès HTTP. PostgreSQL n'apporte pas de bénéfice immédiat pour un seul propriétaire et un seul serveur ; le réserver à plusieurs instances actives ou un besoin mesuré. Préparer authentification, session expirante, déploiement privé, sauvegarde/restauration et workers typés révocables. Ne jamais exposer directement le serveur local historique.
3. Branche PWA séparée à partir du socle vérifié : garder Pixel Art et les panneaux existants, adapter la navigation tactile, cache limité aux ressources statiques publiques et page hors ligne, aucune file d'actions sensibles à rejouer.
4. Régression globale, recette desktop/mobile sur données fictives, documentation de livraison avec statut développé/testé/déployé/opérationnel.

Comparer les hébergements sur leurs pages officielles avant recommandation. Les achats, DNS, comptes réels, migration de données et mise en production restent soumis au propriétaire. Sans moteur connecté, les collectes autorisées continuent et les travaux IA restent en attente. Des bases locales séparées ne garantissent pas une exécution unique mondiale.

## État de livraison

Phase 9 révisée : **528 tests réussis, zéro échec/skip**, 22 Skills et 11 agents cohérents. Régressions reproduites avant correction : routes historiques sans garde commune ; pause puis reprise pendant une collecte ; bail IA abandonné avant/après redémarrage ; contrôle UI de reprise absent pour les attentes de quota/concurrence. Les corrections ferment ces chemins, gardent les résultats incertains en attente de décision et ne relancent aucune IA automatiquement.

Recette navigateur en base mémoire : bureau des onze agents, Automation Center, deux règles fictives inactives, formulaire, dix modèles et commande de réexamen accessibles. La barre desktop déborde dans la vue étroite : traitement prévu Phase 11, donc aucune validation mobile globale annoncée. Aucun appel fournisseur réel. Les tests prouvent les contrats simulés, pas la disponibilité d'un abonnement.

Limites Phase 9 : un seul exécuteur désigné par base ; pas de verrou entre bases indépendantes ; arrêt empêche les nouveaux lancements, pas l'annulation garantie d'une inférence déjà partie ; budget financier constaté après appel ; sources concurrentielles/analytics non connectées. Codex reporté. Aucun déploiement ni fusion.
