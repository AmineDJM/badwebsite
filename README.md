# Google Maps Scraper — Manager

Une interface web pour piloter le scraper open-source
[gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper) (MIT) :
créer et suivre un ou plusieurs jobs de scraping Google Maps, récupérer les
sites web / emails / téléphones des établissements, prévisualiser et
télécharger les résultats en CSV.

**Aucune clé API n'est nécessaire.** Le moteur scrape Google Maps via un
Chromium headless (Playwright) — il n'appelle aucune API Google payante.

## Comment ça marche

Un seul conteneur Docker fait tourner deux processus :

1. **`google-maps-scraper -web`** (le moteur d'origine, compilé depuis le
   dépôt upstream) — écoute en interne sur `127.0.0.1:8081`, jamais exposé
   publiquement. Il gère la file de jobs, la base SQLite (`jobs.db`) et
   l'export CSV.
2. **`server/server.js`** — un petit serveur Node (zéro dépendance npm) qui :
   - sert l'interface (`public/`) sur le port public (`$PORT`, fourni par
     Render),
   - protège tout le site avec une authentification HTTP Basic
     (`ADMIN_USERNAME` / `ADMIN_PASSWORD`),
   - fait passerelle (`/api/*`) vers l'API REST du moteur interne.

```
navigateur → server.js (auth + UI + proxy) → google-maps-scraper -web (127.0.0.1:8081)
```

### Exécution en série, dans l'ordre

Le moteur upstream n'exécute **qu'un seul job à la fois** (c'est un choix du
projet `gosom/google-maps-scraper`, pas une limitation ajoutée ici). Mais il
choisit le prochain job en attente par `created_at DESC` — c'est-à-dire le
**dernier créé en premier** (LIFO), pas l'ordre dans lequel vous les avez
soumis.

Pour que "plusieurs scrapers lancés en série" respecte réellement l'ordre
affiché à l'écran, cette interface ajoute son propre **dispatcheur FIFO**
(`server/server.js`) : chaque job que vous lancez (mode "Un scraper" ou
"Plusieurs scrapers") est d'abord mis dans une file d'attente interne,
persistée sur le disque (`$DATA_FOLDER/queue.json`, survit aux redémarrages).
Toutes les 3 secondes, le serveur regarde s'il y a déjà un job en cours dans
le moteur ; si non, il envoie le suivant de la file — un seul à la fois,
strictement dans l'ordre de soumission. La file d'attente (jobs pas encore
envoyés au moteur) s'affiche dans le panneau **"File d'attente"**, avec leur
position ; une fois envoyé, le job apparaît normalement dans le tableau
**"Jobs"** avec son statut réel (en cours / terminé / échoué).

Pour du vrai parallélisme (plusieurs jobs en même temps, pas juste en série),
il faudrait déployer plusieurs instances du service (chacune avec son propre
disque/port) — l'engin lui-même ne le permet pas dans un seul processus.

## Utilisation

1. Ouvrez l'URL du service, connectez-vous (Basic Auth).
2. Renseignez un nom de job et une ou plusieurs recherches (une par ligne,
   ex: `restaurants paris`).
3. Choisissez **"Un scraper"** (toutes les lignes = un seul job avec
   plusieurs mots-clés) ou **"Plusieurs scrapers"** (chaque ligne devient son
   propre job, lancés automatiquement à la suite).
4. Cochez "Extraire l'email" si vous voulez que le scraper visite le site web
   de chaque établissement pour y trouver un email.
5. Suivez le statut dans le tableau de droite (rafraîchi toutes les 4s),
   puis **Aperçu** ou **Télécharger** une fois le job `terminé`.

Les résultats contiennent 36 champs par établissement (nom, catégorie,
adresse, téléphone, **site web**, note, avis, **email** si activé, etc.).

## Déploiement sur Render

Ce dépôt contient un `render.yaml` (Blueprint) prêt à l'emploi.

1. Sur [Render](https://dashboard.render.com), **New → Blueprint**, pointez
   vers ce dépôt.
2. Render détecte `render.yaml` et crée un service Docker avec :
   - un disque persistant monté sur `/data` (résultats + base des jobs —
     **indispensable**, sans lui tout est perdu à chaque déploiement),
   - un `ADMIN_PASSWORD` généré automatiquement (modifiable dans le
     dashboard → Environment).
3. Premier build : ~5-10 min (compilation Go + installation de Chromium).

Le plan par défaut est `standard` (2 Go RAM). Un Chromium headless consomme
facilement 500 Mo-1 Go selon la charge (`-email`, `-extra_reviews`, plusieurs
mots-clés) ; le plan `starter` (512 Mo) peut fonctionner pour des scrapes
légers mais risque l'OOM sur des jobs plus lourds — ajustez `plan:` dans
`render.yaml` selon votre usage et votre budget.

### Variables d'environnement

| Variable | Rôle | Défaut |
|---|---|---|
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Authentification Basic Auth de l'interface | générés par `render.yaml` |
| `DATA_FOLDER` | Dossier de stockage (jobs.db + CSV + queue.json) | `/data` |
| `SCRAPER_INTERNAL_PORT` | Port interne du moteur (ne pas exposer) | `8081` |
| `PORT` | Port public (fourni automatiquement par Render) | `3000` en local |
| `DEFAULT_PROXIES` | Optionnel — proxies appliqués par défaut à tout job qui n'en spécifie pas (liste séparée par virgules ou retours à la ligne) | vide (aucun proxy) |

## Ai-je besoin de proxies ?

**Non, pas pour démarrer.** Le déploiement fonctionne tel quel sur Render,
sans aucune clé API ni proxy. Pour un usage léger à modéré (quelques jobs par
jour, profondeur raisonnable), l'IP du service suffit.

Les proxies deviennent utiles si vous scrapez **beaucoup, souvent, ou avec
beaucoup de mots-clés d'affilée** : Google peut alors limiter ou bloquer
temporairement l'IP qui fait toutes ces requêtes. Deux façons d'en ajouter
si besoin, sans rien redéployer :
- Globalement pour tous les jobs : variable d'environnement `DEFAULT_PROXIES`
  (dashboard Render → Environment).
- Au cas par cas : champ "Proxies" dans les options avancées du formulaire,
  pour un job donné.

Protocoles supportés par le moteur : `http`, `https`, `socks5`, `socks5h`.

## Développement local

```bash
docker compose up --build
```

Puis ouvrez http://localhost:3000 (identifiants par défaut dans
`docker-compose.yml` : `admin` / `changeme` — à changer).

## Sécurité

- L'interface entière (UI + API) est protégée par HTTP Basic Auth dès que
  `ADMIN_USERNAME` et `ADMIN_PASSWORD` sont définis. **Changez le mot de
  passe généré par Render avant tout usage réel.**
- Le moteur de scraping n'est jamais exposé publiquement : seul
  `server.js` (avec l'authentification) est accessible depuis l'extérieur.
- Respectez les conditions d'utilisation de Google Maps et la réglementation
  applicable (RGPD notamment si vous stockez des données personnelles comme
  des emails). Voir la notice légale du projet upstream.

## Crédits

Moteur de scraping : [gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper)
(licence MIT). Cette interface de gestion (`server/`, `public/`, `Dockerfile`,
`render.yaml`) est un projet séparé qui pilote ce moteur via son API REST
interne — voir `NOTICE`.
