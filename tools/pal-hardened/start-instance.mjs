// Seul --dry-run est disponible : ne charge ni PAL, ni .env, ni profil utilisateur.
if (process.argv.length !== 3 || process.argv[2] !== '--dry-run') {
  process.stderr.write('Instance PAL désactivée : seul --dry-run est autorisé.\n');
  process.exitCode = 2;
} else {
  const pal = '%USERPROFILE%/tools/pal-mcp-server';
  process.stdout.write(JSON.stringify({
    status: 'proposal_only', server: 'pal-hardened', active: false,
    command: `${pal}/.pal_venv/Scripts/python.exe`, args: [`${pal}/server.py`],
    cwd: '<TEMP_DEDIE_VIDE>',
    envNames: ['SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'CLI_CLIENTS_CONFIG_PATH'],
    config: 'tools/pal-hardened/cli_clients/codex.json',
    gateCommand: ['<NODE_ABSOLU>', '<PROJET>/tools/pal-hardened/pal-analysis-gate.mjs'],
    blockers: ['Chargeur PAL : .env actif et surcharges utilisateur à neutraliser dans une future instance isolée.',
      'Config à résoudre vers chemins absolus ; aucun lancement possible dans cette version.'],
  }) + '\n');
}
