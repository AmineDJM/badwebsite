# Google Maps Scraper — Manager

Une interface web pour piloter le scraper open-source
[gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper) (MIT) :
créer et suivre un ou plusieurs jobs de scraping Google Maps, récupérer les
sites web / emails / téléphones des établissements, prévisualiser et
télécharger les résultats en CSV.

**Aucune clé API n'est nécessaire.** Le moteur scrape Google Maps via un
Chromium headless (Playwright) — il n'appelle aucune API Google payante.

## Démarrage en 4 étapes

1. **Déployez** : Render → New → Blueprint → ce dépôt. Le `render.yaml` fait
   le reste (premier build : 5-10 min).
2. **Mot de passe** : Render → Environment → `ADMIN_PASSWORD`. Render en génère
   un aléatoire ; notez-le ou remplacez-le. Il protège toute l'interface.
3. **Proxy** (indispensable pour du volume) : Render → Environment →
   **Add Environment Variable** → clé `DEFAULT_PROXIES`, valeur :
   ```
   http://VOTRE_USER-FR-{session}:VOTRE_PASS@p.webshare.io:80
   ```
   Gardez `{session}` tel quel : il est remplacé par une session neuve à chaque
   job. Détails et réglages Webshare exacts dans la section "Proxies".
   **N'utilisez pas `DEFAULT_PROXIES` et `PROXY_LIST_URL` en même temps** —
   les deux alimentent le même pool et vos jobs alterneraient entre les deux.
4. **Vérifiez avant de lancer** : ouvrez l'interface et cliquez
   **« Tester le proxy »** en haut à droite. Le serveur ouvre un vrai tunnel
   par votre proxy et affiche l'IP de sortie :
   - `✓ Proxy fonctionnel — les requêtes sortent depuis l'IP …` → vous pouvez
     lancer vos scrapes.
   - `✗ identifiants refusés (407)` → user/mot de passe incorrects (pensez à
     encoder les caractères spéciaux : `@` → `%40`).
   - `Aucun proxy configuré` → l'étape 3 n'est pas prise en compte.

Sans proxy valide, Google renvoie des pages vides : vous obtiendrez des jobs
avec 0 résultat, ou des lignes sans nom ni téléphone. L'interface le détecte
et met la file en pause, mais mieux vaut le vérifier avant.

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
| `PROXY_LIST_URL` | Optionnel — lien « proxy list » du fournisseur, téléchargé et rafraîchi automatiquement (voir Option B) | vide |
| `PROXY_LIST_REFRESH_MINUTES` | Fréquence de rafraîchissement de cette liste | `30` |
| `SCRAPER_CONCURRENCY` | Vitesse globale du moteur (voir "Vitesse et mode headless" ci-dessous) | `2` |
| `SCRAPER_BROWSER_POOL_SIZE` | Avancé — voir section "Proxies" (uniquement utile avec une liste de plusieurs IP statiques) | `0` (auto) |
| `JOB_MAX_ATTEMPTS` | Nombre de tentatives avant d'abandonner un job sans résultat | `3` |
| `JOB_RETRY_DELAY_MINUTES` | Délai de base avant reprise (tentative n = n × ce délai) | `5` |
| `BLOCK_PAUSE_THRESHOLD` | Jobs consécutifs sans résultat avant mise en pause de la file | `3` |
| `JOB_DELAY_SECONDS` | Pause entre deux jobs | `30` |
| `ZOMBIE_SLACK_MINUTES` | Marge au-delà du temps max d'un job avant de le considérer bloqué | `5` |

## Vitesse et mode headless

- **Le moteur est toujours headless** (pas d'interface graphique visible) sur
  ce déploiement — c'est normal et nécessaire : Render n'a pas d'écran, et le
  mode serveur (`-web`) du moteur ne propose de toute façon pas d'option pour
  afficher le navigateur, même en local. Pour "voir" ce qui se passe, il faut
  se fier au statut des jobs et aux résultats — pas de fenêtre à regarder.
- **La vitesse se règle à deux niveaux** :
  - Par job, dans le formulaire : la **profondeur** (plus profond = plus de
    résultats mais plus lent) et le **mode rapide** (jusqu'à ~21 résultats
    par recherche, plus rapide, mais nécessite une position lat/lon).
  - Globalement, pour tout le service : `SCRAPER_CONCURRENCY` (dashboard
    Render → Environment) contrôle combien de recherches sont traitées en
    parallèle à l'intérieur d'un même job. Plus élevé = plus rapide, mais
    plus de RAM/CPU consommés (chaque unité ≈ un onglet Chromium
    supplémentaire) — à augmenter en même temps que le `plan:` du service si
    besoin.

## Robustesse : ce qu'il faut savoir avant de scraper en volume

J'ai audité le code du moteur upstream (et de `scrapemate`, la brique de
crawling en dessous) pour répondre précisément à la question "est-il malin
face aux blocages ?". **Réponse honnête : non, le moteur n'a aucune notion de
blocage.** Voici les faits, puis ce que cette interface ajoute pour compenser.

### Ce que le moteur NE fait PAS (vérifié dans son code)

| Situation | Comportement réel du moteur |
|---|---|
| CAPTCHA / page "trafic inhabituel" | **Aucune détection.** La page renvoie un HTTP 200, elle est parsée normalement et produit 0 résultat |
| Blocage / IP grillée | **Aucune bascule de proxy.** La fonction prévue pour ça (`RefreshIP`) est un `// TODO Implement` non implémenté |
| Bandeau de consentement Google | Tentative de clic sur "reject", **en anglais et allemand uniquement** — pas en français |
| Google change la structure de ses pages | **Aucune erreur.** Les champs sont lus à des positions fixes dans un tableau JSON ; en cas de décalage, les colonnes sortent vides sans que rien ne le signale |
| Job qui ne ramène rien | **Marqué "terminé" quand même.** Le statut est mis à `ok` sans jamais regarder le nombre de résultats — un scrape totalement bloqué produit un fichier de 0 octet affiché comme un succès |
| Rythme des requêtes | **Aucun.** Pas de délai, pas de jitter : il tape aussi vite que la concurrence le permet |
| Camouflage (stealth) | Chromium quasi standard, User-Agent Chrome 91 (2021). Détectable |
| Cloudflare sur le site d'un établissement (extraction d'email) | Erreur avalée, colonne email vide — indistinguable de "pas d'email" |

Conséquence directe : **sans garde-fous, vous pouviez vous retrouver avec 50
jobs "terminés" et 50 fichiers vides, sans aucune alerte.**

### Ce que cette interface ajoute par-dessus

Comme le moteur ne peut pas être corrigé sans le forker, la robustesse est
implémentée dans la couche de gestion (`server/server.js`) :

1. **Le statut du moteur n'est jamais cru sur parole.** À la fin de chaque
   job, le serveur relit le fichier de résultats et **compte réellement les
   lignes**. 0 ligne = échec, quoi qu'en dise le moteur.
2. **Reprise automatique.** Un job sans résultat est relancé jusqu'à
   `JOB_MAX_ATTEMPTS` fois, avec un délai croissant (5 min, puis 10) — parce
   qu'un blocage ne se lève pas en trois secondes.
3. **Disjoncteur anti-gaspillage.** Après `BLOCK_PAUSE_THRESHOLD` jobs
   consécutifs sans résultat, **toute la file se met en pause** et une alerte
   rouge s'affiche dans l'interface, au lieu de brûler vos 200 recherches
   restantes contre un mur. Vous corrigez (proxy), puis vous cliquez
   "Reprendre la file".
4. **Détection de changement de page Google.** Le serveur échantillonne le
   CSV : si plus de 50 % des lignes n'ont pas de nom d'établissement, c'est
   que Google a bougé sa structure. Le job échoue immédiatement (inutile de
   réessayer) et la file se met en pause avec un message explicite — plutôt
   que de vous livrer des milliers de lignes vides.
5. **Anti-blocage de la file.** Le moteur laisse parfois un job coincé en
   "en cours" pour toujours (bug upstream : le statut n'est pas mis à jour en
   cas d'erreur). Comme les jobs s'exécutent un par un, cela figerait tout :
   un chien de garde détecte le dépassement (`max_time` + marge), abandonne
   le job et passe au suivant.
6. **Rythme.** `JOB_DELAY_SECONDS` (30 s par défaut) entre deux jobs.
7. **Langue par défaut `en`.** Le bandeau de consentement n'est géré qu'en
   anglais/allemand par le moteur : en `fr`, un job peut revenir vide. Les
   établissements trouvés sont les mêmes, seules les catégories changent de
   langue.

### Ce qui reste hors de portée (soyez lucide là-dessus)

- **Aucune solution ne résout un CAPTCHA.** Si Google en sert un, le job
  revient vide ; l'interface le détectera et vous alertera, mais la vraie
  réponse reste : de bons proxies résidentiels et un rythme raisonnable.
- **Le camouflage du navigateur ne peut pas être amélioré** sans forker le
  moteur. C'est la raison n°1 pour laquelle les proxies résidentiels ne sont
  pas optionnels en usage intensif.
- **La colonne `emails` est peu fiable** par nature (site protégé, timeout,
  email en image…). Une case vide ne veut pas dire "pas d'email".
- **Si Google change sa structure**, le seul vrai correctif est une mise à
  jour du moteur upstream. L'interface vous préviendra dès la première
  occurrence — elle ne pourra pas réparer l'extraction à sa place.

**En résumé : ce n'est pas "100 % fonctionnel quoi qu'il arrive" — aucun
scraper Google Maps ne peut l'être. Mais vous ne travaillerez jamais à
l'aveugle : tout échec est détecté, signalé et, quand c'est utile, réessayé
automatiquement.**

## Proxies

**Pour démarrer, non.** Le déploiement fonctionne tel quel sur Render, sans
clé API ni proxy. Mais **pour un usage intensif dès le début** (beaucoup de
jobs, tous les jours), configurez un proxy dès le départ : sans ça, l'IP du
service Render se fera limiter/bloquer par Google assez vite, avant même que
vous ayez le temps de vous en rendre compte.

### Quel type de proxy ?

Pour scraper Google Maps spécifiquement, un proxy **datacenter** classique
(le moins cher) se fait repérer très vite par Google — c'est reconnu comme
trafic automatisé. Il faut des proxies **résidentiels rotatifs** (IP de
particuliers, donc indiscernables d'un vrai visiteur).

### Option A : réglages Webshare exacts (recommandé)

Dans le dashboard Webshare :

| Réglage | À choisir | Pourquoi |
|---|---|---|
| **Authentication method** | **Username/Password** | L'option « IP Authorization » n'autorise qu'**une seule IP par compte** (au-delà, c'est une option payante), et l'IP de sortie de Render n'est ni dédiée ni garantie stable. Identifiants = ça marche partout, tout de suite. |
| **Connection method** | **Backbone** (`p.webshare.io:80`) | Adresse stable, les IP changent dessous sans toucher à votre config. |
| Rotation | **Session « sticky »**, via l'ID de session dans le nom d'utilisateur | Voir ci-dessous — surtout **pas** « Rotating Proxy Endpoint ». |

**Pourquoi PAS « Rotating Proxy Endpoint » :** il change d'IP **à chaque
requête**. Or une seule page Google Maps déclenche des dizaines de
sous-requêtes (scripts, images, appels internes). Elles sortiraient chacune
depuis une IP différente — un comportement qu'aucun vrai visiteur ne produit,
et qui casse les cookies/la session en cours de route. C'est *pire* que pas de
rotation du tout pour un scraper qui pilote un navigateur.

**Le bon réglage — une IP par job :** collez une URL en session sticky en
remplaçant l'identifiant de session par `{session}` :

```
http://VOTRE_USER-FR-{session}:VOTRE_PASS@p.webshare.io:80
```

Le serveur remplace `{session}` par un identifiant aléatoire **à chaque
lancement de job** (et à chaque reprise après échec — c'est précisément le
moment où l'IP précédente venait d'être bloquée). Résultat : une IP stable et
cohérente pendant toute la durée d'un job, une IP différente d'un job à
l'autre. Sans le placeholder, l'URL est utilisée telle quelle (une seule IP
pour tout, qui finira par griller).

L'**Endpoint Generator** du dashboard Webshare construit la chaîne exacte pour
vous (pays, ville…) — prenez-la et remplacez juste l'ID de session par
`{session}`.

⚠️ **Gardez vos jobs sous 30 minutes.** Chez Webshare, une session sticky tient
**30 min maximum**. La durée max par job est à 20 min par défaut dans le
formulaire, ce qui passe largement. Si vous la montez au-delà de 30 min, l'IP
changera en cours de job et vous perdrez la cohérence de session recherchée.
Mieux vaut découper en plusieurs jobs plus courts (le mode « Plusieurs
scrapers » est fait pour ça) que lancer un job très long.

### Quelle offre Webshare acheter : Static ou Rotating Residential ?

**Rotating Residential.** Le Static est pourtant 4× moins cher (20 IP dédiées
à 6 $/mois, bande passante illimitée, contre ~27,50 $/mois pour 10 Go en
Rotating), mais il ne convient pas ici.

La raison tient au moteur : **il n'a aucune bascule automatique quand un proxy
est bloqué**. Avec le Static, vous possédez 20 IP fixes et rien d'autre ; sous
scraping quotidien, Google finit par identifier ces IP précises, et chaque IP
grillée est une perte définitive de capacité — la file continuera de lui
envoyer des jobs qui reviendront vides, et la seule issue sera de remplacer
les IP à la main. Les IP « ISP » du Static sont en plus hébergées dans des
plages datacenter connues (AT&T, Sprint, Cox) : elles tiennent plus longtemps
que du datacenter pur, mais se dégradent en jours/semaines sous volume.

Avec le Rotating, chaque job tire une IP fraîche dans un pool de 80 M : une IP
grillée n'est jamais réutilisée, le problème ne s'accumule pas. C'est aussi le
mode pour lequel le mécanisme `{session}` décrit plus haut est conçu — le
Static ne connaît pas la notion de session (ses IP sont permanentes) et devrait
passer par la liste téléchargeable (Option B).

Budget de départ conseillé : **10 Go/mois**, qui couvre de l'ordre de 10 000
fiches. Mesurez votre consommation réelle le premier mois avant d'ajuster.

### Ce que je recommande : Webshare

[Webshare.io](https://www.webshare.io/) — le plus simple et le moins cher
pour démarrer :
- Compte gratuit sans carte bancaire : 10 proxies datacenter + 1 Go/mois,
  utilisable indéfiniment (suffisant pour tester avant de payer).
- Proxies résidentiels rotatifs à partir d'environ **3,50 $/Go** (dégressif
  avec le volume).
- Configuration en une ligne : leur dashboard vous donne directement une URL
  du type `http://user:pass@p.webshare.io:80` — copiez-collez, rien d'autre
  à faire.

Budget réaliste pour 2 000 à 10 000 fiches/mois : environ **15-40 $/mois**
avec des proxies résidentiels. (Decodo/Smartproxy et IPRoyal sont des
alternatives correctes, un peu plus chères ; évitez Oxylabs/Bright Data —
pensés pour des grosses entreprises, plus chers et plus compliqués à mettre
en place pour un usage comme le vôtre.)

### Option B : le lien « proxy list » de Webshare

Si vous préférez utiliser le lien de téléchargement de liste fourni par
Webshare (celui qui ressemble à
`https://proxy.webshare.io/api/v2/proxy/list/download/XXXX/-/any/username/direct/-/`),
collez-le dans la variable d'environnement **`PROXY_LIST_URL`**.

Le serveur s'en charge entièrement :
- il télécharge la liste au démarrage puis la rafraîchit toutes les 30 min
  (`PROXY_LIST_REFRESH_MINUTES`) — vos proxies peuvent changer chez Webshare
  sans que vous ayez à retoucher la config ;
- il convertit automatiquement le format Webshare `ip:port:user:pass` en URL
  utilisable (les formats `user:pass@ip:port` et `http://…` sont aussi acceptés) ;
- il **fait tourner un proxy différent à chaque job**, en round-robin sur toute
  la liste.

⚠️ **Ce dernier point est essentiel** : si on passait la liste entière au
moteur, il n'utiliserait en pratique que les 1 ou 2 premiers proxies (un proxy
par navigateur, pour toute la durée de vie du navigateur). C'est l'interface
qui choisit un proxy par job, pour que toute la liste serve réellement.

**Sécurité** : ce lien contient votre jeton d'API — il n'est jamais écrit dans
les logs ni transmis au navigateur. Mettez-le uniquement dans les variables
d'environnement Render.

**Garde-fou** : si le lien devient invalide ou que la liste revient vide, la
file **se met en pause** au lieu de lancer les jobs sans proxy (ce qui
grillerait l'IP du serveur Render). Vous voyez l'alerte dans l'interface.

⚠️ **Attention au type de proxies** : le lien de liste correspond en général
aux proxies **datacenter** (dont les 10 gratuits). Google les repère en
quelques dizaines de requêtes. Pour du volume réel, il faut du
**résidentiel** — chez Webshare il se consomme via `p.webshare.io` avec une
session (Option A ci-dessus), pas via la liste téléchargeable.

### Comment le configurer ici

- **Globalement**, pour que tous les jobs en profitent automatiquement :
  variable d'environnement `DEFAULT_PROXIES` (dashboard Render → Environment
  → modifier la valeur, pas besoin de redéployer le code).
- **Au cas par cas** : champ "Proxies" dans les options avancées du
  formulaire, pour un job donné (prioritaire sur `DEFAULT_PROXIES`).

Dans les deux cas, **collez une seule ligne** au format sticky décrit
ci-dessus. Protocoles supportés par le moteur : `http`, `https`, `socks5`,
`socks5h`. Si le mot de passe contient un caractère spécial (`@ : / % ?`),
encodez-le (ex. `@` → `%40`) sinon l'URL ne sera pas lue correctement.

### Pourquoi une seule URL plutôt qu'une liste d'IP

Techniquement, le moteur attribue **un proxy par navigateur Chromium, pour
toute la durée de vie de ce navigateur** (pas de rotation en cours de job, et
**pas de bascule automatique** si un proxy se fait bloquer — ce point n'est
pas implémenté côté moteur upstream). Si vous collez une liste de 10 IP
statiques, seules les 1-2 premières seront réellement utilisées, à moins
d'augmenter aussi `SCRAPER_BROWSER_POOL_SIZE` (voir `render.yaml`) pour qu'il
y ait un navigateur — donc un proxy — par IP de la liste.

L'URL sticky unique avec `{session}` évite complètement ce problème : la
rotation est pilotée par cette interface, au bon rythme (un job = une IP), sans
dépendre d'une fonctionnalité que le moteur n'a pas. Pas besoin de toucher à
`SCRAPER_BROWSER_POOL_SIZE`.

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
