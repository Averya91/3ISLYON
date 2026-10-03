# V15 — Migration Cloudflare Workers

Cette branche préserve l'API Express et sert `public/` comme assets Cloudflare. Aucun token n'est inclus dans Git.

1. Créer un compte Cloudflare Workers Free, puis **Workers & Pages → Create → Import a repository**, et choisir `Averya91/3ISLYON` après fusion.
2. Utiliser la configuration `wrangler.jsonc` et la commande de déploiement `npx wrangler deploy`. Installer les dépendances avec `npm install`.
3. Ajouter `RENTMAN_TOKEN` dans **Worker → Settings → Variables and Secrets** comme **Secret**, avec un nouveau token Rentman. `RENTMAN_BASE_URL` est déjà configuré.
4. Tester `/api/health`, `/api/equipment`, `/api/availability?from=YYYY-MM-DD&to=YYYY-MM-DD`, la recherche des personnes et la réservation sur l'URL workers.dev **avant** la bascule du domaine.
5. Seulement après les tests, configurer le domaine personnalisé sur Cloudflare et retirer Netlify.

**Limites importantes :** Workers Free a un quota quotidien et un plafond de sous-requêtes par invocation. `/api/availability` parcourt encore tout `/projectequipment`, donc cette migration ne garantit pas de résoudre les limites Rentman. Les parcours de réservation et les accès personnels doivent être vérifiés avant production. Le couple numéro de demande + e-mail actuel ne constitue pas une authentification forte : ajouter une vérification e-mail avant une ouverture publique.

Développement : `npm install`, `npm run dev`. Express local : `npm run dev:node` avec `.env` non versionné. Ne jamais committer de secrets.
