# Archipel v3, chantier A : bâtiments fermés et îles volantes en pixel art (spécification)

Date : 2026-11-17 · Statut : à valider · Maquettes : `docs/maquettes/v3-archipel.html` (mode « Îles volantes », palette « Lagon ») et `docs/maquettes/v3-personnages.html`.

## 1. Objectif

Refaire tout le style de l'archipel pour obtenir un rendu abouti, détaillé et sans « style IA » :

- chaque département devient un **bâtiment fermé** dont l'architecture dépend du métier ;
- les îles restent **volantes**, avec un dessous rocheux, et sont reliées à la place centrale par des **télécabines** ;
- tout le dessin passe en **pixel art pur** (aucun anticrénelage), avec une lumière et des règles de couleur uniques.

Ce document couvre le **chantier A** uniquement. La demande d'origine se découpe en trois chantiers, chacun avec sa spécification et son plan :

| Chantier | Contenu | Statut |
|---|---|---|
| **A** | Extérieur : bâtiments fermés, nouveau style de l'archipel | ce document |
| B | Clic sur un bâtiment : zoom puis entrée dans le bâtiment | plus tard |
| C | Intérieur : plusieurs pièces et bureaux, éditeur pour ajouter des murs | plus tard |

## 2. Décisions validées

| Sujet | Décision |
|---|---|
| Style des bâtiments | Un type par métier (option C) |
| Palette | « Lagon » : verts vifs, palmiers |
| Monde | Îles volantes dans le ciel, liaisons par télécabines (pas d'océan) |
| Agents sur la carte | Plus dessinés à leur bureau ; activité montrée par des signes extérieurs |
| Éditeur d'île | Permet de choisir le type de bâtiment |
| Rendu | Approche 1 : dessins à la taille native, agrandis ×3 sans lissage |
| Personnages | Mini-passants 6×11 sur la carte ; personnages 64×64 actuels inchangés ailleurs |

## 3. Hors périmètre

- Zoom puis entrée dans un bâtiment (chantier B). Au chantier A, le clic ouvre la fenêtre de l'île comme aujourd'hui.
- Intérieurs, pièces, bureaux, murs et taille des personnages à l'intérieur (chantier C).
- Toute modification de l'API des agents, des missions, des messages et des validations.
- Les couleurs du sol et des murs (`floor`, `wall`) restent en base et dans l'API, sans être affichées ni modifiables au chantier A. Elles serviront au chantier C.

## 4. Direction artistique (règles fixes)

Ces règles s'appliquent à tout ce qui est dessiné sur la carte. La maquette v3 en est la référence visuelle.

- **Projection** : isométrie 2:1. Les arêtes isométriques avancent par marches de 2 px horizontaux pour 1 px vertical.
- **Aucun anticrénelage** : tous les remplissages se font par lignes de pixels entiers (balayage). Aucun `fill()` de chemin canvas ni `globalAlpha` sur les volumes. Le seul usage de transparence autorisé concerne les halos lumineux et les nuages.
- **Lumière** : en haut à gauche, identique partout.
  - Face gauche claire, face droite plus sombre (`hs(couleur, −0.22)`).
  - Rangée du haut de la face gauche et arête avant de la face droite légèrement éclaircies.
  - Ombres portées au sol dans l'axe de la face gauche.
- **Décalage de teinte** : la fonction `hs(couleur, k)` assombrit en tirant vers le bleu-violet (teinte 250°) quand k < 0. Elle éclaircit en tirant vers le jaune (teinte 55°) quand k > 0. On ne l'applique pas aux gris (saturation < 0,04).
- **Contours sélectifs** : bâtiments, objets et personnages ont un contour `#2a2033`. Le terrain et le ciel n'en ont pas.
- **Échelle native** :
  - 1 étage = 8 px ;
  - rayon d'une île = 84 px ; rayon de la place centrale = 110 px ;
  - épaisseur visible du bord de l'île = 6 px ;
  - porte ≈ 12 px de haut ;
  - mini-passant = 6×11 px avec contour.
- **Palette Lagon** (valeurs de départ, à ajuster visuellement) :
  - herbe `#5fb04a`, clair `#8bd162`, sombre `#3d8a3c` ;
  - roche `#9a6a48` (face gauche) et `#76503a` (face droite) ;
  - feuillage `#3f9a45`, clair `#72c95c`, sombre `#2a6b3c` ;
  - troncs `#8f6544` ;
  - pavés `#e4d8bf`.
- **Sources lumineuses** (fenêtres allumées, lampadaires, gyrophares, antennes) : jamais teintées par le moment de la journée.

## 5. Architecture

### 5.1 Nouveaux modules (logique pure, testable avec un faux contexte canvas)

| Fichier | Rôle | Interface principale |
|---|---|---|
| `public/pixel.js` | Primitives pixel et couleur | `rect`, `pix`, `poly` (balayage), `polyDither`, `line`, `ell`, `glow`, `dia`, `inDia`, `hs`, `tinter(phase)` |
| `public/buildings.js` | Les 9 bâtiments, les cours et les primitives de volume | `TYPES[type] = { a, b, h, door: [k, w, h], draw(ctx, B, opts) }`, `YARDS[type](ctx, x, y, opts)`, `box`, `fr` (rectangle sur une face), `roofPt`, `punched`, `ribbon`, `curtain` |
| `public/skyworld.js` | Ciel et éléments vivants hors des îles | `drawSky(ctx, phase, w, h)`, `cloud(...)`, `gondolaAt(route, t)`, `drawGondola(...)`, `drawBirds(...)` |

Chaque fonction de dessin reçoit son contexte en paramètre (pas de variable globale `g` comme dans la maquette). Chaque fonction qui place des éléments au hasard reçoit son générateur (seed). Le même seed donne toujours le même dessin.

### 5.2 Modules modifiés

- **`public/world.js`**
  - La disposition est calculée en coordonnées natives : `DX = 170`, `DY = 85`, `RI = 84`, `RH = 110`, `CL = 6`.
  - Les positions dans le monde sont ces coordonnées multipliées par `K = 3` (constante exportée).
  - `computeWorld` garde l'ordre actuel des anneaux (`RING1`, puis `RING2`).
  - Les îles ne grandissent plus avec le nombre d'agents : on supprime `ISLAND.GROW` et le calcul `grow`.
  - On supprime `FURNITURE`, `deskSpots`, `placeAgents`, `roomPoint` et `drawDesk`.
  - `drawIsland` et `drawHub` dessinent à la taille native dans le canvas fourni : dessous rocheux, bord, dessus, chemin, station, bâtiment et décor.
  - `islandBounds` couvre le dessous rocheux, le bâtiment et la station, en coordonnées natives et en coordonnées monde.
  - On ajoute `pillSpot`, `buildingHit`, `stationSpot` et `plotSpot`, qui tiennent compte du type et de la hauteur du bâtiment.
- **`public/app.js`**
  - Les caches d'îles et de place centrale sont créés à la taille native, puis tracés avec `drawImage(cache, x·K, y·K, w·K, h·K)` et `imageSmoothingEnabled = false`.
  - Le ciel (`drawSky`) est dessiné à la taille native puis agrandi.
  - Les éléments animés sont dessinés sous la transformation `zoom × K`, en coordonnées natives entières.
  - On supprime `drawAgents`, les boutons d'agents sur la carte et leurs icônes de statut. On garde `drawLinks` et `drawBeams`, avec des positions recalculées.
- **`public/viewport.js`** : `ZOOMS = [1/3, 2/3, 1, 4/3, 2]`. L'étiquette affiche le pourcentage arrondi (33 %, 67 %, 100 %, 133 %, 200 %).
- **`public/island-style.js`**, **`src/studio.js`** : voir §8.
- **`public/style.css`** : position de la bulle et du panneau « + », mise en évidence des résultats de recherche (§9).

## 6. Le monde

### 6.1 Îles volantes

Chaque île (place centrale comprise) se dessine de bas en haut :

1. **Dessous rocheux** :
   - deux triangles (face gauche, face droite) qui partent des arêtes avant du bord et se rejoignent en une pointe située `R × 0,5` plus bas ;
   - 4 lignes de strates qui foncent vers la pointe, et une trame plus sombre sur les 45 % du bas ;
   - une vingtaine de cailloux en relief (un pixel clair et un pixel sombre) ;
   - 18 racines ou lianes de 3 à 12 px qui pendent du bord ;
   - 3 petits rochers flottants (cubes de 3 px) de chaque côté.
2. **Bord** : 6 px, roche, une ligne de strate, quelques cailloux.
3. **Dessus** : couleur du terrain choisi (herbe par défaut), avec des pixels clairs et sombres (≈ 9 % de la surface), des touffes, et 7 massifs de 6 fleurs. L'arête avant gauche est éclaircie, l'arête avant droite foncée, et quelques gouttes d'herbe débordent sur le bord.
4. **Chemin pavé** : de la porte jusqu'à la station, en contournant le bâtiment selon le côté de la station (points de passage de la maquette).
5. **Station de télécabine** sur le bord le plus proche de la place centrale :
   - ponton en planches avec un lampadaire ;
   - pylône de 16 px avec une traverse.
6. **Décor**, trié par profondeur avec le bâtiment :
   - arbres de l'essence choisie et buissons ;
   - haies sur les bords arrière ;
   - une clôture sur un bord avant ;
   - un banc, un lampadaire au bout du chemin ;
   - la cour du bâtiment, placée du côté opposé au chemin.

La place centrale garde les éléments de la maquette :
- dallage en losanges ;
- fontaine circulaire autour du cristal violet, sur son socle ;
- 4 arbres en jardinière, 4 lampadaires, 3 bancs ;
- une rangée de drapeaux aux couleurs des départements ;
- 4 stations.

### 6.2 Ciel

- **Couleurs** : on réutilise `PALETTES[phase]` de `sky.js` (`skyTop`, `skyBottom`, `cloud`, `cloudShade`).
- **Dégradé** : 14 bandes, avec 2 lignes tramées entre deux bandes.
- **Étoiles** (nuit) : 200 points, dont 1 sur 29 en forme de croix.
- **Nuages lointains** : 10 nuages figés dans le cache du ciel, à 45 % d'opacité.
- **Nuages qui dérivent** : 7 nuages animés. 5 passent derrière les îles et 2 devant.

### 6.3 Télécabines et oiseaux

- **Télécabines** :
  - un câble par île, entre le haut du pylône de la station et celui de la station de la place centrale située en face ;
  - le câble fléchit de 10 px au milieu ;
  - la cabine fait 9×7 px, de la couleur d'accent du département, avec une fenêtre éclairée la nuit ;
  - elle va et vient avec un arrêt de 3 s à chaque station et un mouvement adouci ;
  - les départs sont décalés d'une île à l'autre ;
  - câbles et cabines sont dessinés au-dessus des îles.
- **Mouettes** : 4 qui traversent la carte avec un battement d'ailes sur 2 images.

## 7. Les bâtiments

### 7.1 Types (emprise a × b en px natifs, hauteur h)

| Clé | Nom | Par défaut pour | a × b × h | Détails obligatoires |
|---|---|---|---|---|
| `siege` | Siège | Direction | 34 × 34 × 54 | Pierre claire, 6 étages de fenêtres à appui blanc, colonnade au rez-de-chaussée, bandeau d'accent sous le toit, verrière sur le toit, drapeau d'accent |
| `entrepot` | Entrepôt | Catalogue | 50 × 36 × 26 | Bardage cannelé, bandeau d'accent, 2 portes roulantes, quai béton avec bord jaune et noir, fenêtres de bureau, enseigne, 3 lanterneaux |
| `atelier` | Atelier loft | Création | 36 × 34 × 34 | Briques avec joints, fenêtres d'atelier à croisillons, vitrine et store rayé d'accent, escalier de secours, toit en dents de scie vitré, cheminée |
| `panneau` | Immeuble à panneau | Marketing | 36 × 36 × 40 | Béton blanc, bandeaux vitrés à meneaux, rez-de-chaussée vitré, 2 climatiseurs, grand panneau d'accent sur pieds (pictogramme et lignes de texte), contour lumineux la nuit |
| `accueil` | Accueil | Service client | 38 × 36 × 27 | Rez-de-chaussée entièrement vitré avec silhouettes, auvent et enseigne d'accent, fenêtres à l'étage, parabole, climatiseur, antenne qui clignote |
| `hangar` | Hangar technique | Opérations | 46 × 40 × 24 | Tôle cannelée, 2 portes de garage dont une entrouverte (lumière dedans la nuit), cheminée rayée rouge et blanc qui fume, 2 extracteurs |
| `tour` | Tour vitrée | Données | 26 × 26 × 100 | Mur-rideau en verre avec reflets en diagonale, couronne d'accent lumineuse la nuit, hall vitré, local technique sur le toit, antenne qui clignote |
| `labo` | Labo à dôme | Laboratoire | 38 × 36 × 25 | Blanc, bandeaux vitrés bleu-vert, bandeau d'accent, panneaux solaires, dôme d'observation avec fente (éclairée la nuit) |
| `bureaux` | Bureaux modernes | Tout autre département | 36 × 36 × 34 | Béton clair, bandeaux vitrés, rez-de-chaussée vitré, auvent d'accent, climatiseurs |

Règles communes :
- **Porte** : sur la face droite, environ 12 px de haut. Cadre `#3a3540`, poignée dorée. Éclairée de l'intérieur le soir et la nuit.
- **Emblème** : s'il est choisi, il est peint (9×9 natif) sur l'enseigne, la bannière ou le panneau du bâtiment. S'il n'y a pas d'enseigne, il va sur un écusson au-dessus de la porte.
- **Ombre portée** au sol : longueur `min(22, h × 0,3)`.
- **Position** : le bâtiment est centré 14 px en arrière du centre de l'île.

### 7.2 Cours (décor propre au métier)

- Siège : 2 massifs de fleurs et une statue.
- Entrepôt : camionnette, cartons, palette.
- Atelier : sculpture de cubes de couleur, banc, range-vélos.
- Panneau : kiosque d'affichage, banc.
- Accueil : 2 parasols d'accent, banc.
- Hangar : conteneur d'accent, fûts, plot.
- Tour : parking avec 2 voitures.
- Labo : serre, potager.
- Bureaux : banc, massif.

## 8. Données et éditeur

### 8.1 Base de données (`src/studio.js`)

- La table `island_styles` reçoit une colonne `building TEXT`, vide par défaut.
- **Migration au démarrage** :
  - après les `CREATE TABLE IF NOT EXISTS`, lire `PRAGMA table_info(island_styles)` ;
  - si la colonne `building` est absente, exécuter `ALTER TABLE island_styles ADD COLUMN building TEXT` ;
  - les lignes existantes sont conservées, avec `building = NULL` (bâtiment par défaut du métier).
- `setIslandStyle` enregistre et renvoie `building`. `mapIslandStyle` l'expose.

### 8.2 Règles de style (`public/island-style.js`)

- `OPTIONS.building` contient les 9 clés du §7.1. `LABELS_FR.building` contient leurs noms en français.
- `STYLE_FIELDS` inclut `building`. `isValidIslandStyle` refuse toute valeur hors de la liste.
- `applyStyle` : `building` retenu s'il est valide, sinon `identity.building`, sinon `'bureaux'`.
- `IDENTITY` (dans `world.js`) reçoit la clé `building` pour chacun des 8 départements, selon le tableau du §7.1.
- Le terrain (`ground`) colore le dessus de l'île. Le type d'arbre (`tree`) fixe l'essence principale : `round`, `pine`, `palm` ou `blossom`, ce dernier dessiné comme un arbre rond rose. Les buissons sont toujours présents. `lanterns` active les lampadaires du chemin et de la station.

### 8.3 Éditeur d'île (onglet Personnaliser)

- Ordre des champs :
  1. Nom
  2. **Bâtiment** (nouveau)
  3. Accent
  4. Terrain
  5. Arbres
  6. Lampadaires (ancien « Lanternes »)
  7. Emblème
- Les listes Sol et Murs sont retirées du formulaire. Le brouillon envoyé à l'API reprend les valeurs `floor` et `wall` déjà enregistrées, pour ne pas les effacer.
- L'aperçu en direct, l'annulation et le retour à l'identité d'origine fonctionnent comme aujourd'hui (`previewIsland` recalcule le cache de l'île).

## 9. Signes d'activité et interactions

### 9.1 Signes d'activité (les agents ne sont plus dessinés sur la carte)

- **Bulle** : contenu actuel inchangé. Elle est placée au-dessus du point le plus haut du toit (`pillSpot`), selon le type de bâtiment.
- **Fenêtres allumées** :
  - chaque fenêtre reçoit un rang fixe, tiré du seed de l'île ;
  - une fenêtre est allumée si son rang est inférieur à `taux × facteur` ;
  - `taux = 0,1 + 0,8 × (agents en cours / agents)`, ou `0,05` si l'île n'a aucun agent ;
  - `facteur` : matin 0, midi 0, soir 0,6, nuit 1 ;
  - comme les rangs sont fixes, quand l'activité augmente on allume de nouvelles fenêtres sans éteindre les précédentes ;
  - le cache de l'île est recalculé quand le nombre d'agents en cours change.
- **Agent bloqué** : un gyrophare rouge (2×2 natif) clignote au-dessus de la porte, avec un halo la nuit. Il s'affiche tant qu'au moins un agent de l'île a le statut `blocked`.
- **Passants** :
  - `min(4, nombre d'agents activés de l'île)` mini-passants (agents dont `enabled` n'est pas `false`), qui vont et viennent entre la porte et le bout du chemin ;
  - chacun représente un agent réel : sa grille est calculée à partir de `appearanceFor(agent)`, avec 2 pas animés, de face à l'aller et de dos au retour ;
  - la place centrale a 6 passants décoratifs.
- **Recrutement** : quand un agent apparaît (même règle de détection qu'aujourd'hui, `knownAgents`), une télécabine part de la place centrale vers son île. Le mini-passant en descend, marche jusqu'à la porte et disparaît à l'intérieur. Cette animation remplace `walkers`.
- **On garde** : les arcs pointillés des messages entre îles (partant du haut des bâtiments) et le faisceau du cristal.

### 9.2 Interactions

- **Bâtiment** : un bouton HTML transparent couvre son rectangle englobant (`buildingHit`) et ouvre `show('island', id)`.
- **Bulle** : bouton, même action qu'aujourd'hui.
- **Panneau « + »** (`plotSpot`, près de la station) : bouton qui ouvre le recrutement. Même `aria-label` qu'aujourd'hui.
- **Place centrale** : bouton sur le cristal et la fontaine. Il ouvre `show('hub', 'hub')`.
- **Recherche** : on retire les boutons d'agents. Une bulle dont l'île contient au moins un agent correspondant reçoit la classe `match` et un badge avec le nombre d'agents trouvés.
- **Mini-carte** : inchangée.
- **Clavier et lecteurs d'écran** : tous les éléments cliquables restent des `<button>` avec `aria-label` en français. L'ordre de tabulation suit l'ordre des îles.

## 10. Rendu et performances

- **Cache d'île** : ≈ 260 × 330 px natifs (place centrale ≈ 330 × 300). Il est recalculé lors :
  - d'un changement de moment de la journée ;
  - d'un changement de style (aperçu compris) ;
  - d'un changement du nombre d'agents en cours ou de la présence d'un agent bloqué sur l'île.
- **Cache du ciel** : un canvas natif de la taille du monde divisée par K. Il est recalculé quand le moment de la journée ou la taille du monde change.
- **Animation** :
  - nuages, télécabines, passants, gyrophares, antennes, fumée et mouettes sont dessinés à chaque image sous la transformation `zoom × K`, avec des coordonnées natives arrondies à l'entier ;
  - cadence limitée à environ 12 images par seconde quand rien ne bouge. Le déplacement et le zoom restent fluides (on garde la séparation actuelle entre rendu interactif et animation) ;
  - avec `prefers-reduced-motion` : une seule image fixe. Nuages, cabines et passants restent à leur position de départ.
- **Netteté** : `ZOOMS × K` est toujours un entier (1, 2, 3, 4, 6), donc chaque pixel natif occupe un nombre entier de pixels à l'écran.

## 11. Erreurs

- API : un `building` inconnu → 400 « Style d'île invalide. » (message existant).
- Rendu : un `building` inconnu venant de la base (ancienne version, donnée modifiée à la main) → bâtiment par défaut du métier, sans erreur.
- Migration : si `ALTER TABLE` échoue, le serveur s'arrête avec un message explicite. On ne démarre jamais avec un schéma partiel.

## 12. Tests (`node:test`)

| Fichier | Vérifie |
|---|---|
| `test/pixel.test.js` (nouveau) | Un losange rempli a le nombre de pixels attendu. Tous les appels `fillRect` ont des coordonnées et des tailles entières. `hs(c, −k)` est plus sombre et sa teinte va vers 250°. `hs` ne touche pas la teinte d'un gris. La teinte par moment de la journée est mise en cache. |
| `test/buildings.test.js` (nouveau) | Chacun des 9 types se dessine sans erreur dans son rectangle englobant déclaré (faux contexte qui enregistre les appels). Le même seed donne la même suite d'appels. Le nombre de fenêtres allumées ne baisse jamais quand l'activité augmente. La porte est sur la face droite. |
| `test/world.test.js` (mis à jour) | Ordre des îles dans les anneaux inchangé. Une île avec 0, 9 ou 31 agents a la même taille. `islandBounds` contient le dessous rocheux et le haut du bâtiment le plus haut. Chaque métier a son bâtiment par défaut, et un style le remplace. Les tests de bureaux et de croissance des îles sont supprimés. |
| `test/island-style.test.js` | `building` valide accepté, inconnu refusé. `applyStyle` retombe sur la valeur par défaut. |
| `test/studio.test.js` | Une base créée avec l'ancien schéma (sans `building`) est migrée au démarrage, avec ses lignes conservées. `setIslandStyle` enregistre `building`. |
| `test/server.test.js` | `PUT /api/departments/:id/style` avec `building` → 200 et valeur renvoyée. Valeur inconnue → 400. |
| `test/viewport.test.js` | Chaque zoom × K est un entier. La conversion écran ↔ monde est réversible à chaque zoom. Seuls les zooms autorisés sont acceptés. |

**Vérification manuelle** : lancer l'app et comparer avec `docs/maquettes/v3-archipel.html` aux 4 moments de la journée et aux 5 zooms. Vérifier en plus :
- les préférences « réduire les animations » et thème sombre ;
- l'aperçu en direct de l'éditeur ;
- un recrutement (télécabine puis passant qui entre) ;
- un agent bloqué (gyrophare) ;
- une recherche (bulle mise en évidence).

## 13. Points ouverts pour les chantiers suivants

- B : transition de zoom vers le bâtiment cliqué et ouverture de la vue intérieure.
- C : taille des personnages à l'intérieur (64×64 actuels dans une vue agrandie, ou taille intermédiaire), pièces, bureaux, murs ajoutables, réutilisation de `floor` et `wall`.
