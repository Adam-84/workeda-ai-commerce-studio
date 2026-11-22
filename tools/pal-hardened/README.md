# Instance proposée, désactivée

Ne pas installer ces snippets dans une configuration active. `node tools/pal-hardened/start-instance.mjs --dry-run` affiche uniquement le plan (variables par noms). Tout autre mode échoue ; aucun serveur ni Codex n'est lancé.

Le JSON est accepté par le chargeur PAL audité, mais ne suffit pas à isoler PAL : ses configs intégrées, ses surcharges utilisateur et son `.env` restent des sources de configuration. Son chemin de gate relatif suppose le cwd déclaré ; un futur lanceur devra résoudre Node et gate en chemins absolus. Le lanceur actuel n'exécute rien et ne crée aucun cwd.

Le gate refuse tout, y compris avec un accord et un profil prétendument vérifié. Il ne lit ni contexte stdin, ni configuration, ni accord et ne crée aucun enfant ni connexion. Il vide son environnement (SystemRoot/WINDIR seulement), utilise un cwd temporaire neuf dans le projet, puis le supprime. Aucun environnement n'est transmis à un enfant. La liste blanche du dry-run est une proposition future, pas un confinement du processus Node déjà lancé par PAL.

Le snippet MCP pointe volontairement vers un lanceur refusant l'activation. Le snippet hook et le refus global sont deux alternatives : le refus global bloque aussi Gemini/Claude/agy via clink. Voir `docs/PAL-HARDENING.md` pour limites et preuves à refaire.
