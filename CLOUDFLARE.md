# V15 — Migration Cloudflare Workers

Cette branche préserve l'API Express et sert `public/` comme assets Cloudflare. Aucun token n'est inclus dans Git.

1. Créer un compte Cloudflare Workers Free, puis **Workers & Pages → Create → Import a repository**, et choisir `Averya91/3ISLYON` après fusion.
2. Utiliser la configuration `wrangler.jsonc` et la commande de déploiement `npx wrangler deploy`. Installer les dépendances avec `npm install`.
3. Ajouter `RENTMAN_TOKEN` dans **Worker → Settings → Variables and Secrets** comme **Secret**, avec un nouveau token Rentman. `RENTMAN_BASE_URL` est déjà configuré.
4. Tester `/api/health`, `/api/equipment`, `/api/availability?from=YYYY-MM-DD&to=YYYY-MM-DD`, la recherche des personnes et la réservation sur l'URL workers.dev **avant** la bascule du domaine.
5. Seulement après les tests, configurer le domaine personnalisé sur Cloudflare et retirer Netlify.

**Limites importantes :** Workers Free a un quota quotidien et un plafond de sous-requêtes par invocation. `/api/availability` parcourt encore tout `/projectequipment`, donc cette migration ne garantit pas de résoudre les limites Rentman. Les parcours de réservation et les accès personnels doivent être vérifiés avant production. Le couple numéro de demande + e-mail actuel ne constitue pas une authentification forte : ajouter une vérification e-mail avant une ouverture publique.

Développement : `npm install`, `npm run dev`. Express local : `npm run dev:node` avec `.env` non versionné. Ne jamais committer de secrets.


## V16.5 — demandes locales (sans Rentman Pro)

Lyon peut gérer les demandes sans l'option Rentman « Demandes de location ». Les demandes, messages et décisions du magasin sont stockés dans Cloudflare D1.

### 1. Créer la base D1 (une seule fois)

```bash
npx wrangler d1 create 3islyon-requests
```

Wrangler affiche un `database_id`. Ajoute ensuite ce binding dans `wrangler.jsonc` avec l'identifiant retourné :

```jsonc
"d1_databases": [
  {
    "binding": "REQUESTS_DB",
    "database_name": "3islyon-requests",
    "database_id": "COLLER_ICI_LE_DATABASE_ID"
  }
]
```

### 2. Créer les tables

```bash
npx wrangler d1 execute 3islyon-requests --remote --file=./schema.sql
```

### 3. Accès magasin

Le secret Cloudflare `RESERVATION_ACCESS_SECRET` déjà configuré sert de code d'accès à `/magasin.html`. Ne jamais le mettre dans le dépôt ni dans le JavaScript public.

### 4. Déployer

```bash
npx wrangler deploy
```

Flux V16.5 : catalogue → demande locale D1 → espace magasin → accepter/refuser + messagerie. L'acceptation ne crée pas encore automatiquement un projet Rentman : cette étape sera raccordée séparément à `POST /projects` après validation du flux et des champs BETA de l'API Rentman.


## V16.20 — migration D1 et notifications e-mail

Avant de déployer V16.20 sur une base déjà existante, appliquer une seule fois :

```bat
npx wrangler d1 execute 3islyon-requests --remote --file=./migration-v1620.sql
```

La suite magasin ajoute : archivage, calendrier, workflow de préparation/retrait/retour, contrôle de stock avant acceptation, modification des quantités, pièces jointes, historique d'activité, QR de retrait et génération devis/facture.

Les notifications e-mail sont optionnelles. Elles utilisent l'API HTTP Resend uniquement si ces deux secrets/variables sont configurés :

```bat
npx wrangler secret put RESEND_API_KEY --name 3islyon
npx wrangler secret put MAIL_FROM --name 3islyon
```

`MAIL_FROM` doit être une adresse autorisée par le domaine vérifié chez le fournisseur e-mail, par exemple `Magasin 3iS Lyon <magasin@catalogue-3is.fr>`.

Les pièces jointes sont volontairement limitées à 600 Ko par fichier dans cette version et stockées dans D1. Pour des fichiers lourds, migrer le stockage vers R2.


## V17.3 — suppression définitive de la date de naissance

Pour une base ayant déjà reçu la première migration V17.0, exécuter une fois :

```bat
npx wrangler d1 execute 3islyon-requests --remote --file=./migration-v173.sql
npx wrangler deploy
```

Cette migration reconstruit la table `magasin_users` sans la colonne `birth_date` et conserve les comptes existants.
