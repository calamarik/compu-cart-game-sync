# Format de cartouche Compu-Cart (schemaVersion 1)

Référence unique du format lu par Compu-Cart et produit par la forge. Une cartouche est une **liste de jeux** :
une cartouche mono-jeu est simplement une liste d'un seul élément, avec exactement la même structure.

## Arborescence

```
/
├── compucart.json          fichier racine : titre (optionnel) + liste ordonnée des jeux
├── <Nom du jeu>.lnk        raccourci Windows par jeu (usage sans Compu-Cart, voir plus bas)
├── games/<id>/             jeu installé
├── saves/<id>/             sauvegardes du jeu (chemin déduit de l'id, jamais stocké)
└── manifests/<id>.json     manifeste du jeu
```

`<id>` est la clé unique d'un jeu : même valeur pour `games/`, `saves/`, `manifests/`, pour la synchronisation des
sauvegardes et pour la liste du fichier racine. Il ne change jamais après la création de la cartouche.

- Caractères autorisés : `a-z A-Z 0-9 _ -` (`^[a-zA-Z0-9_-]+$`), donc sûr comme nom de dossier Windows.
- Windows ignore la casse des noms de dossier : deux id qui ne diffèrent que par la casse sont refusés.
- La forge recommande un slug en minuscules sans accent (« Baldur's Gate : Enhanced » → `baldurs-gate-enhanced`),
  avec un suffixe numérique en cas de collision ; Compu-Cart n'impose que la règle ci-dessus.

## `compucart.json` (racine)

```json
{
  "schemaVersion": 1,
  "title": "Ma compilation",
  "games": ["jeu-a", "jeu-b"]
}
```

| Champ | Obligatoire | Rôle |
|---|---|---|
| `schemaVersion` | oui | Doit valoir `1`. Toute autre valeur (ou son absence) est refusée avec une erreur claire. |
| `title` | non | Nom de la cartouche. Absent : le titre du jeu s'il n'y en a qu'un, sinon « Cartouche multijeu ». |
| `games` | oui | Id des jeux, **dans l'ordre d'affichage**, au moins un. Le nombre de jeux est `games.length` (jamais stocké). |

Si un id listé n'a pas de `manifests/<id>.json`, la cartouche est refusée (erreur nommant le jeu) : aucun menu
silencieusement incomplet. La présence de `compucart.json` à la racine est ce qui fait reconnaître une cartouche.

## `manifests/<id>.json`

```json
{
  "schemaVersion": 1,
  "id": "jeu-a",
  "title": "Jeu A",
  "executable": "games/jeu-a/JeuA.exe",
  "args": ["-windowed"],
  "checksums": {
    "games/jeu-a/JeuA.exe": "970fdefd98f9c826530bda9c9115ef34b80f2756b27aa847c02b672946ce19ec"
  }
}
```

| Champ | Obligatoire | Rôle |
|---|---|---|
| `schemaVersion` | oui | `1`. |
| `id` | oui | Doit être égal au nom du fichier (`manifests/<id>.json`). |
| `title` | oui | Nom affiché. Peut être corrigé sans casser les dossiers ni les saves (le dossier suit l'id). |
| `executable` | oui | Chemin de l'exécutable, relatif à la racine de la cartouche. |
| `args` | non | Tableau de chaînes passées au jeu au lancement. |
| `checksums` | oui | `chemin relatif → SHA-256` (64 caractères hexadécimaux). Doit contenir l'exécutable ; peut lister d'autres fichiers du jeu. Seuls les fichiers listés sont vérifiés. |
| `cover` | non | Réservé (jaquette, chemin relatif). Pas encore lu par Compu-Cart. |

Il n'y a **ni `saveDir` ni `intro`** : les sauvegardes sont toujours dans `saves/<id>/`, et l'intro (image, jingle) est
embarquée dans Compu-Cart, identique pour toutes les cartouches.

## Règles communes

- Tous les chemins sont relatifs à la racine de la cartouche, avec `/` comme séparateur, sans lettre de lecteur :
  la lettre change selon le port et le PC. Les chemins sortant du support, absolus ou passant par des liens sont refusés.
- Les clés de `checksums` suivent le chemin de l'exécutable (`games/<id>/...`).
- Les raccourcis `.lnk` ne servent qu'à lancer un jeu **sans** Compu-Cart installé. Compu-Cart ne les lit, ne les crée
  et ne les régénère jamais. Limite connue : si la lettre du lecteur change, le raccourci fonctionne mais perd son icône.

## Comportement de Compu-Cart

- **Un seul jeu** : comme avant. Vérification d'intégrité et synchronisation des sauvegardes au branchement, puis intro
  et lancement automatique (selon l'option « Lancement auto »).
- **Plusieurs jeux** : aucun jeu n'est lancé tout seul. La console passe sur « Prête » et affiche la liste (flèches +
  Entrée, souris, ou sous-menu « Jouer » de l'icône). Le jeu choisi est alors vérifié et synchronisé pendant l'intro,
  puis lancé. Un jeu corrompu est refusé sans bloquer les autres. À la fermeture du jeu : synchronisation retour puis
  retour à « Prête » (comme pour une cartouche mono-jeu).
- Aucune compatibilité avec l'ancien format (un seul `compucart.json` décrivant un jeu, `saveDir`, `intro`) : l'application
  n'était pas encore publiée. Un tel fichier est refusé (`schemaVersion` requis). Les cartouches de test sont à reforger.
