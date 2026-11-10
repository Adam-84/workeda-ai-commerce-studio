# Sprites de personnages (optionnels)

Par défaut, la carte dessine des personnages provisoires dans le code (`public/scene.js`). Ce dossier permet de les remplacer par **vos propres** sprites Pixel Art.

## Règles de licence

- Ne déposez que des fichiers que vous avez créés ou dont la licence autorise cet usage (ex. CC0, CC-BY avec attribution, achat avec licence commerciale).
- Le champ `license` du manifest est **obligatoire** : sans lui, les sprites sont ignorés et les personnages dessinés par code restent affichés.
- Conservez le fichier de licence d'origine à côté des images (ex. `LICENSE-auteur.txt`).
- Ne copiez pas de sprites extraits de jeux commerciaux.

## Format

1. Une feuille PNG par état et par direction de marche, frames alignées horizontalement, toutes de **64×64 px**, 3 frames par état.
2. Un fichier `manifest.json` dans ce dossier (voir `manifest.example.json`) :

```json
{
  "license": "CC0 1.0 — Nom de l'auteur — https://lien-vers-la-source",
  "author": "Nom de l'auteur",
  "frameWidth": 64,
  "frameHeight": 64,
  "anchorX": 32,
  "anchorY": 61,
  "fps": 4,
  "variants": [
    {
      "idle": { "src": "agent-a-idle.png", "frames": 3 },
      "working": { "src": "agent-a-working.png", "frames": 3 },
      "waiting": { "src": "agent-a-waiting.png", "frames": 3 },
      "blocked": { "src": "agent-a-blocked.png", "frames": 3 },
      "walk-down": { "src": "agent-a-walk-down.png", "frames": 3 },
      "walk-up": { "src": "agent-a-walk-up.png", "frames": 3 },
      "walk-left": { "src": "agent-a-walk-left.png", "frames": 3 },
      "walk-right": { "src": "agent-a-walk-right.png", "frames": 3 }
    }
  ]
}
```

- `frameWidth` et `frameHeight` doivent être exactement `64` : sinon le manifest est ignoré.
- `anchorX` / `anchorY` : point des pieds dans la frame (32 / 61 pour une frame 64×64), posé sur l'île.
- États : `idle`, `working`, `waiting`, `blocked`. Directions de marche : `walk-down`, `walk-up`, `walk-left`, `walk-right`.
- `variants` : plusieurs looks possibles ; chaque agent reçoit toujours le même, choisi à partir de son nom et de son rôle.
- Une feuille d'état manquante retombe sur `idle` ; une feuille `walk-*` manquante retombe sur le personnage généré (dessiné par le code).
- L'état affiché vient **toujours** de la base (`idle`, `working`, `waiting`, `blocked`) : un sprite ne crée jamais d'activité.

Le nom `manifest.example.json` n'est pas chargé : copiez-le en `manifest.json` une fois vos images en place.
