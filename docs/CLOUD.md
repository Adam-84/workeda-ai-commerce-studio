# Archipel central : préparation et exploitation privée

Le dépôt prépare un serveur Node 24 unique, une base applicative SQLite et une base de contrôle des workers. Aucun serveur n'a été acheté, publié ou démarré dans Docker pendant cette préparation. Le moteur Docker n'étant pas disponible ici, la validation de configuration ne constitue pas un test du conteneur.

## Architecture et état persistant

`deploy/compose.yaml` publie uniquement `127.0.0.1:4319` sur l'hôte. Le processus non-root écoute `0.0.0.0` **dans** le conteneur pour joindre ce port. La racine est en lecture seule, toutes les capabilities sont retirées, les privilèges supplémentaires sont interdits et `/tmp` est temporaire. Un seul réplica doit posséder les volumes SQLite : ni partage NFS/SMB, ni deux serveurs écrivant les mêmes fichiers. La commande par défaut lance exclusivement `src/cloud-server.js`.

| Volume | Chemin | Rôle |
| --- | --- | --- |
| `archipel_data` | `/var/lib/archipel` | `workeda.db`, `control.db`, sauvegardes, journaux Memory/Comms, secrets chiffrés éventuels |
| `archipel_skills` | `/app/skills` | Sources Skills et catalogue modifiables |
| `archipel_agent_profiles` | `/app/.claude/agents` | Onze fiches et affectations Skills modifiables |
| `archipel_claude_skills` | `/app/.claude/skills` | Copies générées gérées par Archipel |
| `archipel_codex_skills` | `/app/.agents/skills` | Copies générées ; aucun lancement de Codex |

Les volumes nommés vides sont initialisés depuis le contenu de l'image. Les révisions suivantes de l'image ne remplacent pas les Skills/fiches déjà présents : comparer et réconcilier leurs changements explicitement. Ne pas utiliser `docker compose down -v`, qui supprimerait les volumes. La disponibilité multi-appareils dépend du serveur central ; les anciennes bases des deux PC restent intactes.

`.dockerignore` fonctionne par liste autorisée : seules les sources, assets publics, Skills `SKILL.md`, catalogue et fiches requises entrent dans l'image. Les bases, `.env`, sessions CLI, journaux Git, credentials utilisateur et secrets locaux sont exclus. L'image contient les définitions publiques du dépôt, jamais les abonnements ou authentifications du propriétaire.

## Première recette privée sur un hôte Linux

Ces commandes sont un runbook à exécuter volontairement sur un hôte disposant de Docker. Elles n'ont pas été exécutées ici. Depuis la racine du dépôt, utiliser un tag de release identifié et conserver le SHA Git, le digest de l'image Node et celui de l'image construite. Le Dockerfile fixe une version Node 24 ; pour un rebuild strict, passer `--build-arg NODE_IMAGE=node:VERSION-bookworm-slim@sha256:DIGEST_VERIFIE`. La revue des mises à jour de sécurité de cette image reste nécessaire.

```bash
export ARCHIPEL_IMAGE=workeda-archipel:release-REPLACE_WITH_GIT_SHA
docker build --tag "$ARCHIPEL_IMAGE" .
```

Créer le hash du mot de passe avec le module de production, sans mettre le mot de passe dans une commande, une variable d'environnement persistée, Git ou un fichier temporaire. Exemple Bash dans un shell administrateur sur le serveur :

```bash
install -d -m 0700 /srv/archipel-secrets
export ARCHIPEL_PASSWORD_HASH_HOST_FILE=/srv/archipel-secrets/password.hash
umask 077
read -r -s -p 'Mot de passe propriétaire (16 caractères minimum) : ' OWNER_PASSWORD
printf '\n'
printf '%s' "$OWNER_PASSWORD" | docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  "$ARCHIPEL_IMAGE" node --input-type=module -e 'import {hashPassword} from "./src/cloud-auth.js"; let p=""; for await (const c of process.stdin) p+=c; console.log(await hashPassword(p));' \
  > "$ARCHIPEL_PASSWORD_HASH_HOST_FILE"
unset OWNER_PASSWORD
chown 1000:1000 "$ARCHIPEL_PASSWORD_HASH_HOST_FILE"
chmod 0400 "$ARCHIPEL_PASSWORD_HASH_HOST_FILE"
export ARCHIPEL_ORIGIN=http://127.0.0.1:4319
docker compose -f deploy/compose.yaml config --quiet
docker compose -f deploy/compose.yaml up -d --no-build
docker compose -f deploy/compose.yaml ps
curl --fail http://127.0.0.1:4319/healthz
```

Vérifier que la génération a réussi et que le fichier n'est pas vide avant `up`. Le montage secret Compose est en lecture seule ; les permissions du fichier hôte doivent autoriser l'UID 1000. Les implémentations locales de Compose ne remappent pas nécessairement les modes/UID des secrets fichier. Ne pas afficher le fichier dans les logs.

Pour accéder depuis un PC autorisé, ouvrir `ssh -N -L 4319:127.0.0.1:4319 utilisateur@serveur`, puis `http://127.0.0.1:4319`. L'origine configurée doit correspondre exactement au navigateur (hôte et port). Le healthcheck ne donne que `status: ok` ; il ne certifie ni les intégrations, ni un worker disponible, ni les sauvegardes. Vérifier également connexion, refus anonyme des API, tableau d'exploitation et onze agents. Fermer/recréer le conteneur invalide les sessions.

## Workers et secrets d'intégration

Un worker se connecte avec un jeton dédié, révocable, et se lance explicitement avec `node tools/worker.mjs` (voir [WORKERS.md](WORKERS.md), conditions des fournisseurs comprises). Ne pas copier les répertoires de connexion Claude/Codex des PC dans le serveur. L'absence de worker ne déclenche aucun repli payant. Les quotas non connus restent inconnus. Codex reste désactivé ; les copies de Skills ne l'activent pas.

Sous Linux, le magasin de secrets existant exige `ARCHIPEL_SECRET_KEY` (32 caractères minimum). Cette configuration ne fournit aucune clé par défaut, donc les fonctions nécessitant le magasin restent indisponibles. Avant leur activation, prévoir une injection opérateur protégée compatible avec ce contrat, conserver la clé séparément et sauvegarder les blobs chiffrés. Le runtime ne lit pas actuellement de `ARCHIPEL_SECRET_KEY_FILE` : ne pas prétendre qu'un montage seul active le chiffrement. Les blobs DPAPI d'un PC Windows ne sont pas transférables automatiquement. Aucun credential fournisseur n'est embarqué.

## Arrêt général et redémarrage

L'arrêt général reste actif après un redémarrage : aucune mission ni automatisation ne part avant une reprise explicite, même si les calendriers sont rouverts dans Automation Center. La reprise rétablit la suspension des calendriers telle qu'elle était avant l'arrêt.

Au démarrage, les travaux encore en file chez le courtier sont annulés et les missions interrompues en cours d'exécution passent à « bloquée » avec la mention d'un résultat incertain. Rien n'est rejoué sans votre décision.

## Limites connues du mode central

- La connexion OAuth DSers ne fonctionne pas : son retour intersite est refusé par la protection de session. Aucune protection n'est affaiblie pour la contourner.
- Les missions qui demandent des outils web sont refusées : un worker distant ne fournit que des réponses sans outils.
- Derrière un proxy ou Docker, toutes les connexions partagent une adresse : cinq échecs de mot de passe en quinze minutes bloquent aussi le propriétaire jusqu'à l'expiration de la fenêtre. Gardez l'accès sur un réseau privé.
- Une session expire après 30 minutes d'inactivité ou 12 heures, et à chaque redémarrage.
- Les sauvegardes ne sont ni purgées ni exportées hors de l'hôte.

## Sauvegardes, restauration et reprise

Le runtime sauvegarde les deux bases quand la dernière sauvegarde complète a plus de 24 heures : au démarrage si elle est en retard, puis par contrôle horaire. La date survit aux redémarrages. L'action Sauvegarder du tableau d'exploitation déclenche aussi un snapshot. Les artefacts vont dans `/var/lib/archipel/backups/<date-id>/`, avec un manifeste contenant les hashes et résultats d'intégrité. Consulter `lastSuccessfulAt` et `error` ; un healthcheck vert ne suffit pas. Il n'y a pas de rétention automatique ni d'export hors hôte : surveiller l'espace et organiser une copie externe protégée. Les deux bases sont sauvegardées successivement, pas dans une transaction distribuée ; pour une restauration coordonnée, arrêter les travaux et prendre une sauvegarde à froid avant une mise à jour importante.

Les deux bases du serveur central fonctionnent en journal WAL : la sauvegarde lit un instantané pendant que le service continue d'écrire. Des fichiers `-wal` et `-shm` accompagnent alors chaque base ; ne jamais copier à la main le seul fichier principal d'un service actif, et ne jamais déposer une base restaurée à côté des anciens fichiers `-wal`.

Procédure de sauvegarde manuelle d'une base, sans remplacer aucun fichier :

```bash
docker compose -f deploy/compose.yaml exec archipel node tools/database-transfer.mjs backup \
  --source /var/lib/archipel/workeda.db --destination /var/lib/archipel/backups/manual-UNIQUE.sqlite --execute
```

Répéter pour `control.db` avec un autre nom. Le dossier de destination doit exister. Conserver les reçus SHA-256 à part et suivre [DATABASE-TRANSFER.md](DATABASE-TRANSFER.md). Une sauvegarde SQLite n'inclut pas les volumes Skills/fiches, les journaux indépendants, les secrets hors base ou le hash de connexion : sauvegarder ces éléments séparément dans un stockage privé, avec leurs empreintes. Pour une capture complète cohérente, arrêter le service et archiver les cinq volumes ainsi que la configuration protégée hors dépôt. Conserver les anciens volumes au lieu de les écraser.

Restaurer d'abord chaque artefact dans un **nouveau** fichier candidat avec `restore --sha256 HASH --execute`. Préparer de nouveaux volumes/copies, vérifier intégrité et hashes, puis effectuer la recette sur un autre port loopback avec une origine correspondante. La promotion exige d'arrêter l'ancien serveur et de changer explicitement les volumes de la nouvelle instance ; cette commande de transfert n'écrase jamais la base active. Une comparaison de deux historiques n'est pas une fusion : les conflits de clés ou schémas nécessitent une résolution métier distincte. Prévoir la révocation/réinscription des workers restaurés et examiner les missions `uncertain` avant toute reprise ; ne pas rejouer automatiquement une inférence dont le résultat est inconnu.

## Mise à jour et rollback

1. Noter le tag/digest en service ; construire un nouveau tag immuable, sans remplacer l'ancien.
2. Suspendre les travaux depuis le tableau, attendre les traitements en cours, sauvegarder les deux bases et les volumes mutables. Vérifier au moins une restauration sur un nouveau candidat.
3. Arrêter le service, conserver l'état précédent intact, puis lancer la nouvelle image sur les copies de données destinées à la release. Tester healthcheck, authentification, données, Skills et workers avant reprise.
4. En cas d'échec, arrêter la nouvelle instance et rétablir **ensemble** l'ancienne image et son jeu de volumes sauvegardé. Revenir seulement à l'image ne défait pas une migration de schéma.

Le redémarrage automatique `unless-stopped` concerne les sorties du processus ; Docker ne redémarre pas automatiquement un conteneur simplement marqué unhealthy. Diagnostiquer puis redémarrer explicitement. Le délai d'arrêt gracieux est 60 secondes ; un arrêt forcé nécessite une revue des tâches incertaines. Ne jamais lancer deux instances sur le même jeu de bases pour tenter une reprise.

## HTTPS optionnel, étape ultérieure

`deploy/Caddyfile` est un exemple pour Caddy **sur l'hôte**, non lancé par Compose. Après choix explicite d'un hostname, configuration DNS, accès réseau et TLS, définir `ARCHIPEL_HOST=archipel.example.com` côté Caddy et `ARCHIPEL_ORIGIN=https://archipel.example.com` côté application. Caddy transmet le Host d'origine à `127.0.0.1:4319`. Conserver le port applicatif lié au loopback. Pour un usage strictement privé, utiliser un réseau privé/VPN ou le tunnel SSH ; la présence d'un mot de passe ne rend pas le service privé au niveau réseau.

Avant toute exposition autorisée, valider Caddy, les accès TLS depuis les appareils voulus, les cookies Secure, le refus des origines étrangères, la révocation, la reprise, les sauvegardes hors hôte et l'absence d'accès direct au port applicatif. Aucun DNS, certificat, pare-feu ou service public n'a été modifié pendant cette préparation.
