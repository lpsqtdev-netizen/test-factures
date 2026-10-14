# Pétale — La livraison fleurie

Pétale est un MVP de plateforme de coordination entre fleuristes indépendants et livreurs. Il associe une interface web responsive à un serveur Node.js, une API protégée et un stockage local pour les essais.

## Fonctionnalités

- Tableau de bord fleuriste et suivi des commandes.
- Création de commandes avec destinataire, adresse, créneau, bouquet, montant et consignes.
- Dispatch et attribution des missions.
- Espace livreur de démonstration pour accepter et terminer une livraison.
- Annuaire des livreurs partenaires et vue tournée illustrative.
- Registre de facturation de démonstration et export CSV.
- Actualisation périodique des commandes entre navigateurs connectés à la même instance.
- Session administrateur, formulaire de connexion/déconnexion et routes métier protégées.
- Image Docker non privilégiée, health check et volume persistant.

Les données et personnes préremplies sont fictives. Les vues de cartographie, facturation et intégrations restent des démonstrations ; aucun paiement, itinéraire réel, email/SMS ou service Google/n8n n'est activé.

## Démarrage local

Prérequis : Node.js 20.6+ (pour `--env-file`).

```bash
cp .env.example .env
```

Modifier `.env` avec un e-mail administrateur et un mot de passe unique et robuste (au moins 16 caractères recommandé). Ne jamais partager ni commiter le fichier `.env`.

```bash
npm start
```

Ouvrir ensuite http://localhost:3000. L'API et l'interface sont servies sur la même origine. Les données sont enregistrées dans `data/store.json`. Le chemin peut être déplacé avec `PETAL_STORE_PATH`, et le port avec `PORT`.

Sans identifiants administrateur configurés, l'API métier reste fermée et le serveur renvoie une erreur de configuration au login.

## API

- `GET /api/health` — état du service et configuration.
- `POST /api/auth/login` — ouvre une session administrateur.
- `GET /api/auth/me` — utilisateur de la session courante.
- `POST /api/auth/logout` — ferme la session.
- `GET /api/orders` — liste les commandes.
- `POST /api/orders` — crée une commande après validation.
- `PATCH /api/orders/:id/assign` — assigne un livreur et démarre la livraison.
- `PATCH /api/orders/:id/status` — fait évoluer le statut selon le cycle `À préparer → En livraison → Livrée`.
- `GET /api/couriers` — liste de démonstration des livreurs.

Les routes métier exigent une session valide. Le cookie est HttpOnly, SameSite=Strict et expire après 8 heures ; l'attribut Secure est ajouté quand `NODE_ENV=production`. Les tentatives de connexion sont limitées à 10 par adresse IP sur 15 minutes. Les mutations vérifient l'origine lorsqu'un en-tête Origin est présent. Les écritures sont sérialisées dans une seule instance Node afin de réduire les collisions, mais ce mécanisme ne remplace pas une base transactionnelle.

## Tests et intégration continue

```bash
npm test
```

GitHub Actions exécute les tests Node.js et construit l'image Docker. Les tests couvrent notamment les sessions, les identifiants incorrects, la déconnexion, le rejet des requêtes cross-origin, la limitation des tentatives, la validation des entrées, les créations concurrentes, les transitions de statut, l'échappement HTML et la syntaxe JavaScript de l'interface.

## Exécution avec Docker

Créer le fichier `.env` comme décrit ci-dessus, puis :

```bash
docker build -t petale:local .
docker run --rm --env-file .env -p 3000:3000 -v petale-data:/app/data petale:local
```

Le volume `petale-data` conserve les données entre les redémarrages. Le conteneur utilise l'utilisateur non privilégié `node` et vérifie périodiquement le endpoint de santé.

## Limites avant mise en production

**Ne pas exposer publiquement cette version avec des données personnelles réelles.** Il s'agit d'un MVP, pas d'un produit SaaS fini. Avant une mise en production, il reste notamment à :

1. Remplacer le fichier JSON par une base de données transactionnelle adaptée à plusieurs instances.
2. Créer les comptes individuels, invitations et autorisations par rôle (administrateur, fleuriste, livreur).
3. Ajouter journal d'audit, sauvegardes/restaurations, monitoring, gestion de session multi-utilisateur et procédures de récupération.
4. Générer de véritables factures PDF avec numérotation et informations légales configurées.
5. Connecter cartographie, géocodage, itinéraires, notifications et paiements via des intégrations sécurisées.
6. Finaliser les mentions légales, la confidentialité, la conservation/suppression des données et les contrôles de sécurité.
7. Déployer sur un hébergement HTTPS, configurer les secrets et effectuer des tests de charge et de sécurité.

Le déploiement public n'a pas été effectué et la branche reste non fusionnée dans `main`.
