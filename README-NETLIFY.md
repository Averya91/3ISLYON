# 3iS Lyon — version Netlify

Cette version conserve le frontend V10 et le backend Rentman, adapté à Netlify Functions.

## Déploiement recommandé

1. Décompressez ce ZIP.
2. Mettez le dossier sur GitHub (sans fichier `.env`).
3. Dans Netlify, choisissez **Add new project > Import an existing project** et connectez le dépôt.
4. Netlify détecte `netlify.toml` : le dossier publié est `public` et les fonctions sont dans `netlify/functions`.
5. Dans **Site configuration > Environment variables**, ajoutez `RENTMAN_TOKEN` avec votre token Rentman.
6. Déployez / relancez le déploiement.

## Important

- Le token Rentman reste uniquement côté serveur.
- Ne mettez jamais le token dans `public/app.js`, `index.html`, GitHub ou `netlify.toml`.
- Les routes frontend continuent d'appeler `/api/...`; Netlify les redirige vers la Function Express.
- Le projet reste exécutable localement avec `npm install` puis `npm start`.

## Test après déploiement

Ouvrez `https://VOTRE-SITE.netlify.app/api/health`. Si la Function fonctionne, vous devez obtenir une réponse JSON du serveur.


## V14.2 — Correctif timeout Netlify
Les appels Rentman ont désormais un timeout court, un seul retry 429 et les chargements indépendants sont parallélisés afin de rester sous la limite d’exécution Netlify.
