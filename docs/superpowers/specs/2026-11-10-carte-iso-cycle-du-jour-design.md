# Carte isométrique « cycle du jour » — spécification

Date : 2026-11-10 · Statut : à valider · Maquettes : Figma « Workeda — Maquettes de style », page « Cycle du jour + personnages 64×64 », et `docs/maquettes/v2-*.html`.

## 1. Objectif

Remplacer la carte actuelle (îlots pixel art ×3) par un archipel isométrique détaillé : un bâtiment meublé par département, des personnages 64×64 personnalisables dont l'expression suit leur statut réel, des faisceaux de lumière limités aux vrais échanges, et une interface « verre » qui change d'ambiance avec l'heure locale (matin, midi, soir, nuit).

Le backend, les données existantes et les règles de sécurité sont conservés. Rien n'est affiché qui ne vienne pas de SQLite.

## 2. Hors périmètre

- Éditeur de personnalisation des îles (étape suivante).
- Compteurs de modèles (Opus, Sonnet, Haiku…), onglets Calendrier / Éditorial / Cerveau, orchestrateur qui délègue : aucune donnée réelle ne les alimente.
- Connexion réelle à Shopify, Claude Code, Codex, PAL ou clink : la détection reste « détecté / non détecté ».
- Toute dépendance externe (police, bibliothèque, image).

## 3. Monde et navigation

### 3.1 Échelle
- 1 pixel du dessin = 1 pixel d'écran à 100 %. Personnages 64×64.
- Zoom : 50 %, 100 % (défaut), 200 %, par boutons +/− et molette. Rendu sans lissage (`imageSmoothingEnabled = false`).
- La carte (environ 2400×1600) se déplace par glisser (souris, doigt) ou par les flèches du clavier quand la carte a le focus (sans gêner la navigation au `Tab` entre les éléments).
- Au chargement, la vue est centrée sur la place centrale.

### 3.2 Disposition
- Grille isométrique 3×3 : place centrale au milieu, les 8 départements autour, dans l'ordre Direction (haut), Catalogue, Création, Marketing, Service client, Opérations, Données, Laboratoire (sens horaire).
- Pas de grille : DX = 400 px, DY = 200 px (pente 2:1).
- Un département ajouté via l'API se place sur un second anneau (grille 5×5), avec une identité par défaut.
- Passerelles en bois entre la place centrale et les quatre départements adjacents (Catalogue, Marketing, Opérations, Laboratoire).

### 3.3 Île de département
- Plateforme : losange de demi-largeur 240 px, dessus en herbe, épaisseur 16 px, roche en dessous.
- Décor : arbres ronds, lanterne, panneau en bois au nom du département (police pixel, cf. 6.4), parcelle « + » de recrutement.
- La nuit, un liseré de la couleur du département souligne le bord de la plateforme.

### 3.4 Bâtiment (pièce en coupe)
- Losange intérieur de demi-largeur 170 px, sol en planches de la couleur du département.
- Deux murs du fond de 84 px de haut, bandeau supérieur à la couleur du département, plinthe sombre.
- Deux fenêtres sur le mur gauche, une sur le mur droit, allumées le soir et la nuit. Une porte sur le mur droit.
- Mobilier fixe par métier :

| Département | Mobilier |
| --- | --- |
| Direction | grand tapis, bibliothèque, plante, globe |
| Catalogue | deux étagères de cartons, pile de cartons, portant de vêtements |
| Création | chevalet avec toile, table lumineuse, plantes |
| Marketing | tableau blanc à post-it (sans texte), canapé, écran de graphiques |
| Service client | comptoir d'accueil, fauteuil, plante |
| Opérations | tapis roulant avec colis, palette, diable |
| Données | trois baies de serveurs (voyants fixes), antenne parabolique |
| Laboratoire | paillasse avec fioles et microscope, serre vitrée, plante |

- Un bureau avec écran par agent réel, sur une grille intérieure de 3×3 emplacements (9 agents). Au-delà, la pièce et la plateforme s'agrandissent d'un cran (+60 px de demi-largeur).
- Écran allumé si l'agent est `working`, en veille sinon.

### 3.5 Place centrale
- Place ronde dallée avec anneau lumineux, bancs et lampadaires.
- Cristal sur socle : il brille doucement en permanence (décor). Un faisceau vertical ne monte qu'au passage d'un vrai échange (cf. 5).

### 3.6 Ordre de dessin et performance
- Tri par profondeur (méthode du peintre) sur la coordonnée y de la base de chaque objet.
- Chaque île est pré-dessinée sur son propre canvas hors écran, redessiné seulement au changement de données, de phase ou de zoom.
- À chaque image (au plus 25 par seconde) : ciel, nuages, îles en cache, personnages, faisceaux, décor mobile.
- `prefers-reduced-motion` : tout est figé (respiration, nuages, faisceaux réduits à un trait fixe).

## 4. Personnages

### 4.1 Sprites
- Générés par le code dans une grille 64×64 (fichier `public/sprites.js`), par couches : corps, cheveux, tenue, accessoire, visage. Contour sombre automatique autour de la silhouette.
- Options :
  - coupe de cheveux : courte, longue, en pics, chignon, queue de cheval, carré ;
  - couleur de cheveux : 7 teintes ; peau : 4 teintes ; yeux : 4 couleurs ;
  - tenue : blazer, sweat à capuche, pull, veste, blouse, tablier ; couleur principale (palette de 8) ;
  - accessoire : aucun, lunettes, casque audio, casquette, écharpe.
- Tenue par défaut selon le département : Direction blazer, Catalogue sweat, Création pull, Marketing veste, Service client pull + casque, Opérations tablier, Données sweat, Laboratoire blouse.
- Directions : face, dos, profil gauche, profil droit (le droit est le miroir du gauche), 3 frames de marche chacune.
- Mise en cache : un sprite calculé une fois par combinaison (apparence, expression, direction, frame).

### 4.2 Apparence
- Automatique et stable : dérivée d'un hachage de `nom|rôle`.
- Modifiable dans l'onglet « Apparence » de la fiche de l'agent : choix par listes fermées, aperçu en direct, bouton « Revenir à l'automatique ».
- Enregistrée dans SQLite (cf. 7.1). Sans enregistrement, l'apparence automatique s'applique.

### 4.3 Expressions et attitudes (statut réel uniquement)

| Statut | Expression | Attitude | Icône lisse |
| --- | --- | --- | --- |
| `idle` | calme, léger sourire | assis, respiration lente, clignements | aucune |
| `working` | concentré, sourcils droits | assis, tape au clavier, écran allumé | engrenage |
| `waiting` | interrogatif, sourcil levé | assis, tête légèrement levée | sablier |
| `blocked` | soucieux, goutte de sueur | assis, immobile | panneau orange |

- Les icônes sont des SVG nets à la résolution de l'écran, placés en HTML au-dessus de la tête (bulle blanche ronde).
- Agent désactivé : semi-transparent, sans icône.
- Aucune expression ou animation ne dépend d'autre chose que du statut enregistré.

### 4.4 Déplacements
- Un personnage ne marche que lors d'un vrai événement : à son recrutement, il entre par la porte et rejoint son bureau (environ 2 secondes), puis s'assoit.
- Aucune déambulation aléatoire.

### 4.5 Sprites fournis par l'utilisateur
- Le chargeur existant (`public/assets/characters/manifest.json`, licence obligatoire) est conservé et adapté : frames de 64×64, une feuille par état et par direction (`idle`, `working`, `waiting`, `blocked`, `walk-down`, `walk-up`, `walk-left`, `walk-right`).
- Un état manquant retombe sur les sprites générés.

## 5. Faisceaux d'échange

- Calculés par une fonction pure `public/beams.js` à partir des messages et missions réels :
  - message : de l'île de l'expéditeur vers celle du destinataire ;
  - mission : de l'île du demandeur, ou de la place centrale sans demandeur, vers celle de l'agent assigné ;
  - même île : petite étincelle locale au lieu d'un faisceau.
- Trajet : île de départ → cristal (bref éclair vertical) → île d'arrivée, en 2 à 3 secondes.
- Un faisceau n'est joué qu'une fois, quand l'échange apparaît pour la première fois dans les données (pas au premier chargement de la page).
- Les échanges des dernières 24 heures restent visibles en liaisons pointillées faiblement lumineuses.
- Aucun faisceau sans enregistrement réel.

## 6. Interface

### 6.1 Synchronisation avec l'heure
- Phase calculée par `public/sky.js` (inchangé) : Matin 05:00–09:59, Midi 10:00–16:59, Soir 17:00–20:59, Nuit 21:00–04:59. Mode Automatique par défaut, choix manuel mémorisé dans le navigateur.
- La phase est posée sur `<html data-phase>`. Toutes les couleurs de l'interface sont des variables CSS définies par phase, avec une transition douce de 1,5 s.

| Phase | Ciel / carte | Panneaux | Accent |
| --- | --- | --- | --- |
| Matin | pêche et bleu pâle, brume légère, soleil bas | verre crème clair, texte brun | corail `#ff8a5c` |
| Midi | bleu vif, soleil haut | verre blanc, texte encre | violet `#6c5ce7` |
| Soir | violet et orange, fenêtres et lanternes allumées | verre prune, texte crème | ambre `#ffb15c` |
| Nuit | étoiles, lune, liserés néon, faisceaux cyan | verre bleu nuit, texte clair | cyan `#3fd0ff` |

- Contraste texte / fond d'au moins 4,5:1 dans chaque phase.
- Pas de flou d'arrière-plan obligatoire : `backdrop-filter` est utilisé s'il est disponible, sinon le panneau reste opaque à 90 %.

### 6.2 Éléments
- **Barre du haut** : logo, recherche d'agent (filtre par nom ou rôle, met les agents trouvés en évidence, un résultat ouvre la fiche et centre la carte), compteur de missions non terminées, pastille de phase (« ☀ Midi · 13:10 · auto », un clic ouvre les réglages), connexions détectées / non détectées, bouton Réglages (ciel, zoom, légende des statuts).
- **Pastilles d'île** au-dessus de chaque bâtiment : couleur du département, nom, nombre d'agents, nombre en `working`, initiales (3 au plus). Un clic ouvre la fenêtre du département.
- **Barre de mission** en bas : sélecteur d'agent (ou « sans agent ») et titre. Crée une vraie mission (`POST /api/missions`, validation requise par défaut). Pas de délégation automatique.
- **Mini-plan** en bas à droite : une pastille par département, la place centrale au milieu, un cadre pour la zone visible, l'indicateur de zoom. Un clic recentre la carte ; repliable.
- **Fenêtres contextuelles** en verre, avec une pointe vers l'élément et un contour de sélection sur la carte :
  - île : agents, missions liées, recrutement (formulaire puis confirmation), création de mission ;
  - agent : onglets Profil (rôle, statut, source), Apparence, Journal, Messages (lecture et envoi).
- Échap ferme la fenêtre et rend le focus à l'élément d'origine. Tous les éléments de la carte ont un bouton HTML accessible au clavier.

### 6.3 Écran étroit
- Carte à 100 %, déplacée au doigt. Barres du haut et du bas compactes (recherche et connexions passent dans Réglages).
- Fenêtres affichées en feuille en bas de l'écran.

### 6.4 Polices
- Interface : pile système (`system-ui, "Segoe UI", sans-serif`).
- Panneaux en bois et logo : police pixel dessinée dans le code (`public/pixelfont.js`, glyphes 5×7 : A–Z, 0–9, É È Ê À Ç Ô Û Ï, espace, point, tiret, apostrophe).

## 7. Données et API

### 7.1 Nouvelle table
```sql
CREATE TABLE IF NOT EXISTS agent_appearance (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  hair_style TEXT NOT NULL, hair_color TEXT NOT NULL, skin TEXT NOT NULL, eyes TEXT NOT NULL,
  outfit TEXT NOT NULL, top_color TEXT NOT NULL, accessory TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```
- Ajout sans modification des tables existantes ; les données actuelles ne sont pas touchées.

### 7.2 Routes
- `GET /api/appearances` : toutes les apparences enregistrées.
- `PUT /api/agents/:id/appearance` : enregistre une apparence. Chaque champ est validé contre une liste fermée (couleurs incluses). Agent inexistant : 404. Valeur inconnue : 400. Ajoute l'événement `agent.appearance.updated` (source `manual`).
- `DELETE /api/agents/:id/appearance` : revient à l'apparence automatique.
- Le routeur gagne la prise en charge d'un paramètre de chemin (`:id`).
- Inchangé : `POST /api/activity` n'accepte que la source `manual`.

## 8. Organisation du code

| Fichier | Rôle |
| --- | --- |
| `public/iso.js` | primitives : losange, prisme, contours, couleurs (pur) |
| `public/world.js` | disposition de l'archipel, îles, pièces, mobilier, ordre de dessin |
| `public/sprites.js` | génération des personnages 64×64, apparence automatique (pur) |
| `public/beams.js` | faisceaux à partir des messages et missions (pur) |
| `public/pixelfont.js` | police pixel (pur) |
| `public/viewport.js` | zoom, déplacement, conversion écran ↔ monde, mini-plan |
| `public/app.js` | données, fenêtres, formulaires, recherche, barre de mission |
| `public/sky.js` | inchangé (phases) |
| `src/studio.js`, `src/app.js` | table et routes d'apparence |

L'actuel `public/scene.js` est remplacé par `iso.js` + `world.js`.

## 9. Tests

- Disposition : 8 départements à leur place dans la grille 3×3 ; un 9e va sur le second anneau.
- Pièces : un bureau par agent réel ; au-delà de 9 agents, la pièce s'agrandit ; aucun bureau sans agent.
- Sprites : même nom et rôle → même apparence ; apparence enregistrée prioritaire sur l'automatique ; chaque statut donne l'expression attendue ; sprite 64×64 sans pixel hors cadre.
- Faisceaux : uniquement des messages et missions réels, bonnes îles, mission sans demandeur depuis la place centrale, rien au-delà de 24 h, rien rejoué au premier chargement.
- Police pixel : couvre tous les caractères des noms des départements.
- Viewport : conversion écran ↔ monde réversible à 50 %, 100 % et 200 %.
- API apparence : enregistrement, valeur refusée (400), agent inconnu (404), suppression, événement journalisé.
- Existants conservés : activité externe non vérifiée refusée, choix manuel du ciel prioritaire, recrutement visible dans le bon département.

Vérification manuelle : `npm start` sur une base temporaire, les 4 phases, zoom et déplacement, recrutement avec arrivée par la porte, écran étroit ; relecture de code par Codex.

## 10. Sécurité (inchangée)

- Aucun secret dans le dépôt ; aucune connexion simulée ; aucune modification de thème Shopify, de prix ou de commande.
- Toute future écriture Shopify reste derrière une approbation humaine explicite et enregistrée.
- Le contenu venant de la base est inséré en nœuds texte (jamais `innerHTML`).
