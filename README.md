# Pétale — La livraison fleurie

Pétale est un MVP de plateforme de coordination entre fleuristes indépendants et livreurs. Il associe une interface web responsive à un serveur Node.js, une API protégée et un stockage local pour les essais.

## Fonctionnalités

- Tableau de bord fleuriste avec indicateurs calculés depuis les commandes chargées et fil d'activité dynamique.
- Création de commandes avec destinataire, adresse, créneau, bouquet, montant et consignes.
- Isolation des commandes et des paramètres de boutique par compte fleuriste ; l’administrateur conserve une vue globale.
- Dispatch des missions vers des comptes livreurs partenaires enregistrés (les livreurs de démonstration ne peuvent pas recevoir de vraies commandes).
- Espace livreur de démonstration pour accepter et terminer une livraison.
- Annuaire des livreurs partenaires et vue tournée illustrative.
- Registre de facturation de démonstration et export CSV.
- Actualisation périodique des commandes entre navigateurs connectés à la même instance.
- Session administrateur, formulaire de connexion/déconnexion et routes métier protégées.
- Image Docker non privilégiée, health check, volume persistant et sauvegardes locales tournantes du fichier JSON (7 versions maximum).

Les données et personnes préremplies sont fictives. Les vues de cartographie, facturation et intégrations restent des démonstrations ; aucun paiement, itinéraire réel, email/SMS ou service Google/n8n n'est activé. Le serveur peut utiliser SQLite en mode mono-instance ; la migration initiale conserve le JSON d'origine.

## Démarrage local

Prérequis : Node.js 20.6+ (pour `--env-file`).

```bash
cp .env.example .env
```

Modifier `.env` avec un e-mail administrateur et un mot de passe unique et robuste (au moins 16 caractères recommandé). Ne jamais partager ni commiter le fichier `.env`.

```bash
npm start
```

Ouvrir ensuite http://localhost:3000. L'API et l'interface sont servies sur la même origine. Avec le `.env.example`, les données sont stockées dans `data/store.sqlite` via SQLite ; au premier démarrage, un éventuel `data/store.json` est importé sans être supprimé. Sans `PETAL_DATABASE_PATH`, le serveur conserve le mode JSON historique. Les chemins sont configurables avec `PETAL_DATABASE_PATH` et `PETAL_STORE_PATH`, et le port avec `PORT`.

Sans identifiants administrateur configurés, l'API métier reste fermée et le serveur renvoie une erreur de configuration au login.

## API

- `GET /api/health` — état du service et configuration.
- `POST /api/auth/login` — ouvre une session administrateur.
- `GET /api/auth/me` — utilisateur de la session courante.
- `POST /api/auth/password` — changement du mot de passe d'un compte partenaire, avec vérification du mot de passe actuel et révocation des autres sessions (le mot de passe administrateur reste géré par l'environnement).
- `GET /api/settings` / `POST /api/settings` — profil professionnel isolé par compte (boutique, responsable, e-mail, téléphone, adresse de retrait, SIRET et TVA).
- `GET /api/users` / `POST /api/users` — consultation et création de comptes partenaires (administrateur uniquement).
- `GET /api/orders/available` — missions ouvertes sans données de contact privées, réservé aux livreurs.
- `POST /api/auth/logout` — ferme la session.
- `GET /api/orders` — liste les commandes.
- `GET /api/audit` — journal des 200 événements les plus récents (créations et changements de commande).
- `POST /api/orders` — crée une commande après validation.
- `PATCH /api/orders/:id/assign` — assigne un livreur et démarre la livraison.
- `PATCH /api/orders/:id/status` — fait évoluer le statut selon le cycle `À préparer → En livraison → Livrée` et enregistre la date et l'acteur de confirmation.
- `GET /api/couriers` — liste de démonstration des livreurs.

Les routes métier exigent une session valide. Le cookie est HttpOnly, SameSite=Strict et expire après 8 heures ; l'attribut Secure est ajouté quand `NODE_ENV=production`. Les tentatives de connexion sont limitées à 10 par adresse IP sur 15 minutes. Les mutations vérifient l'origine lorsqu'un en-tête Origin est présent, y compris le rejet des en-têtes malformés. Le serveur ajoute une Content Security Policy, les protections anti-frame et les en-têtes de politique cross-origin. Les écritures sont sérialisées dans une seule instance Node ; Les données métier sont stockées dans des tables SQLite indexées. Chaque lecture porte une révision et les écritures utilisent un contrôle optimiste : si un autre processus a enregistré une modification entre-temps, l'écriture obsolète est rejetée avec une erreur 409 plutôt que d'écraser silencieusement les changements. Le modèle reconstruit encore l'état applicatif complet ; il convient à une instance et doit évoluer vers des mutations ciblées avant une forte charge. Avant chaque remplacement du fichier, le serveur conserve une copie privée dans `store.json.backups/` (7 versions maximum). Pour restaurer une sauvegarde, lancer `node scripts/restore-store.js data/store.json.backups/store-....json data/store.json` après avoir choisi le fichier voulu. La commande valide la structure JSON et crée d'abord une sauvegarde de l'état courant. Les sauvegardes restent sur le même disque : elles ne remplacent pas une copie externalisée et testée.

## Préparer une migration SQLite

Le serveur prend en charge SQLite lorsque `PETAL_DATABASE_PATH` est défini. Il importe automatiquement un ancien `store.json` au premier démarrage, sans le supprimer. Les commandes, utilisateurs, livreurs, paramètres de boutique et événements d'audit sont aussi conservés dans des tables SQLite dédiées, avec des index sur les champs de recherche courants. Le serveur relit ces tables normalisées ; les écritures sont atomiques dans une transaction SQLite et créent une sauvegarde privée tournante (7 versions maximum). L'utilitaire CLI permet aussi de préparer une base à partir d'un instantané JSON ; il conserve le fichier source, est idempotent et refuse d'écraser un état cible différent.

```bash
npm install
npm run migrate:sqlite -- data/store.json data/store.sqlite
```

Une seconde exécution sur la même source est sans effet. Si la base cible contient déjà un autre état, la migration s'arrête au lieu d'écraser les données. Conserver également une sauvegarde hors machine avant toute opération de production.

## Tests et intégration continue

```bash
npm test
```

GitHub Actions exécute les tests Node.js et construit l'image Docker. Les tests couvrent notamment l'attribution réservée aux comptes livreurs enregistrés, les sessions, le changement de mot de passe et la révocation des sessions, les identifiants incorrects, la déconnexion, l'isolation des commandes et des profils professionnels entre fleuristes, le rejet des requêtes cross-origin, la limitation des tentatives, la validation des entrées, les créations concurrentes, le journal d'audit, les transitions de statut, l'échappement HTML et la syntaxe JavaScript de l'interface.

## Exécution avec Docker

Créer le fichier `.env` comme décrit ci-dessus, puis :

```bash
docker build -t petale:local .
docker run --rm --env-file .env -p 3000:3000 -v petale-data:/app/data petale:local
```

Le volume `petale-data` conserve les données entre les redémarrages. Le conteneur utilise l'utilisateur non privilégié `node` et vérifie périodiquement le endpoint de santé.

## Limites avant mise en production

**Ne pas exposer publiquement cette version avec des données personnelles réelles.** Il s'agit d'un MVP, pas d'un produit SaaS fini. Avant une mise en production, il reste notamment à :

1. Remplacer progressivement les sauvegardes d'état complet par des mutations métier ciblées ; garder le contrôle de révision en garde-fou et tester la charge avant d'ouvrir plusieurs instances.
2. Compléter les invitations et la récupération de compte, puis auditer les autorisations par rôle (administrateur, fleuriste, livreur).
3. Ajouter une stratégie de sauvegarde externalisée avec tests réguliers de restauration, monitoring, gestion de session multi-utilisateur et procédures de récupération.
4. Générer de véritables factures PDF avec numérotation et informations légales configurées.
5. Connecter cartographie, géocodage, itinéraires, notifications et paiements via des intégrations sécurisées.
6. Finaliser les mentions légales, la confidentialité, la conservation/suppression des données et les contrôles de sécurité.
7. Déployer sur un hébergement HTTPS, configurer les secrets et effectuer des tests de charge et de sécurité.

Le déploiement public n'a pas été effectué et la branche reste non fusionnée dans `main`.
