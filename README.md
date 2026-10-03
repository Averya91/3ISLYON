# 3iS Lyon — Magasin Rentman

Catalogue web du parc matériel 3iS Lyon connecté à l'API publique Rentman.

## Fonctionnalités

- Disponibilité calculée sur une période choisie, avec date de fin incluse côté interface.
- Stock réel lu depuis `equipment.current_quantity` (avec contrôles de repli explicites) et non une valeur 0 par défaut.
- Les champs de stock Rentman sont demandés explicitement via `fields`, car certains champs de quantité peuvent être absents d'une réponse de collection s'ils ne sont pas sélectionnés.
- Recherche et filtres Son / Lumière / Vidéo / Structure / Autre-Divers.
- Planning basé sur `/projectequipment` et les champs `planperiod_start`, `planperiod_end` et `quantity_total`.
- Si Rentman ne fournit réellement aucun champ de stock pour un équipement, l'interface affiche `— / STOCK RENTMAN NON RÉCUPÉRÉ` au lieu de transformer l'absence de donnée en stock 0.
- Images Rentman chargées à la demande et mises en cache.
- Pagination 16 équipements par page.
- Token Rentman uniquement côté serveur.
- Gestion automatique des réponses 429 avec temporisation et cache.

## Installation

```bash
npm install
cp .env.example .env
# renseigner RENTMAN_TOKEN dans .env
npm start
```

Puis ouvrir `http://localhost:3000`.

## Important — token API

Le token fourni dans le chat doit être considéré comme exposé. Rentman recommande de protéger le token comme un mot de passe et de le régénérer s'il a été partagé. Utiliser le nouveau token dans `.env`.

## API Rentman utilisée

- `GET /equipment` avec sélection explicite des champs de stock
- `GET /folders`
- `GET /projectequipment`
- `GET /equipment/{id}` et `GET /files/{id}` pour les images, uniquement à la demande

Le stock total affiché dans le site est basé en priorité sur `current_quantity`, le champ Rentman prévu pour la quantité actuelle. Les réservations de la période sont ensuite déduites pour obtenir `availableForPeriod`.


## Correctif V6 — réservations Rentman
La disponibilité ne soustrait plus `quantity_total` (quantité planifiée sur une ligne projet). Elle soustrait `warehouse_reservations`, c’est-à-dire la quantité réellement réservée dans le stock entrepôt par Rentman pour les lignes dont la période de planification chevauche les dates choisies. Cela évite les faux totaux élevés liés aux combinaisons/kits et aux lignes seulement planifiées.


## V14.2 — Correctif timeout Netlify
Les appels Rentman ont désormais un timeout court, un seul retry 429 et les chargements indépendants sont parallélisés afin de rester sous la limite d’exécution Netlify.
