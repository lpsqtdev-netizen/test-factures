# Pétale — La livraison fleurie

Prototype web responsive d'une plateforme de coordination entre fleuristes indépendants et livreurs.

## Lancer le prototype
Ouvrir simplement `index.html` dans un navigateur. Aucun build ni dépendance d'installation n'est requis. La police utilise Google Fonts ; le reste du prototype fonctionne côté navigateur.

## Fonctionnalités de démonstration
- Tableau de bord fleuriste et indicateurs d'activité
- Création de commandes/livraisons avec destinataire, adresse, créneau, montant et consignes
- Liste filtrable des commandes et assignation de démonstration
- Vue dispatch/tournée avec illustration de carte (non connectée à un service de cartographie)
- Annuaire de livreurs partenaires
- Registre de facturation de démonstration et export CSV des commandes
- Paramètres de boutique et espaces réservés aux intégrations Google Sheets, Google Drive, n8n, cartographie, email/SMS et paiements

## Limites importantes
Cette version est un prototype front-end : les données sont conservées uniquement en mémoire dans la page et sont réinitialisées au rechargement. Il n'y a pas encore de comptes utilisateurs, backend, base de données, géocodage, calcul de trajet réel, notifications, paiement, ni émission de factures conformes. Les chiffres, clients, livreurs et documents préremplis sont fictifs. Les connexions tierces sont volontairement inactives.

## Prochaines étapes recommandées
1. Choisir backend/base de données et authentification avec rôles fleuriste/livreur/admin.
2. Persister les commandes et gérer les transitions de statut côté serveur.
3. Ajouter invitations, disponibilité et preuve de livraison.
4. Intégrer un fournisseur de cartes et optimiser les tournées.
5. Générer des factures PDF avec numérotation et informations légales configurées.
6. Connecter Google Sheets/Drive et les automatisations n8n via des secrets côté serveur.
7. Ajouter tests, validation, journalisation et déploiement.

## Stack
HTML, CSS et JavaScript natifs pour garder la première maquette légère et facilement inspectable.


## Mise à jour — espace livreur
Le prototype inclut maintenant une vue « Espace livreur » :
- consulter les commandes encore à prendre en charge ;
- accepter une mission de démonstration ;
- retrouver ses livraisons en cours ;
- confirmer une livraison et voir le compteur de missions terminées.

Les commandes de démonstration sont également sauvegardées dans le stockage local du navigateur (`localStorage`) afin de survivre à un rechargement sur le même navigateur. Cette sauvegarde n'est ni un compte utilisateur ni une base de données partagée : les données ne se synchronisent pas entre appareils ou entre le fleuriste et le livreur.

Pour les tests, créez une commande depuis « Vue d'ensemble », puis ouvrez « Espace livreur » et acceptez la mission. Les données restent locales à cette session navigateur.


## Serveur API (MVP)
Prérequis : Node.js 20 ou plus récent. Aucune dépendance npm externe n'est requise.

```bash
npm start
```

Puis ouvrir http://localhost:3000. Le serveur sert l'interface et l'API sur la même origine. En mode serveur, les commandes sont enregistrées dans `data/store.json` et partagées par les navigateurs qui utilisent cette même instance.

### Routes disponibles
- `GET /api/health` — état du service et mode de stockage
- `GET /api/orders` — liste des commandes
- `POST /api/orders` — crée une commande après validation
- `PATCH /api/orders/:id/assign` — assigne un livreur et passe la commande en livraison
- `PATCH /api/orders/:id/status` — fait évoluer le statut selon le cycle `À préparer → En livraison → Livrée`; les retours en arrière sont refusés
- `GET /api/couriers` — liste de démonstration des livreurs

Le fichier de données peut être déplacé en définissant `PETAL_STORE_PATH`. Le port est configurable via `PORT`. Les écritures API sont mises en file d'attente dans une même instance Node afin d'éviter les pertes de données lors de créations simultanées ; cela ne remplace pas une base de données et ne protège pas plusieurs instances. Lorsque le front-end est connecté à l'API, il actualise les commandes et le répertoire livreurs toutes les 15 secondes pour répercuter les changements sur les autres navigateurs ouverts.

### Tests automatisés
```bash
npm test
```

Les tests couvrent le health check, la lecture des commandes et livreurs, la création persistante et concurrente sans identifiants dupliqués, la validation des entrées, l'assignation, les transitions de statut, le service du front-end et la syntaxe du JavaScript embarqué. Le workflow GitHub Actions vérifie aussi la construction de l'image Docker.

### Limites et sécurité avant une mise en ligne
Ce backend est une fondation MVP, pas encore un service de production. Le stockage JSON convient à une instance de démonstration et à des essais légers, mais pas à une forte concurrence ni à plusieurs instances. Il n'y a pas encore d'authentification, d'autorisation par rôle, de base SQL, de protection CSRF/rate limiting, de journal d'audit, ni de sauvegarde automatisée. **Ne pas exposer publiquement avec des données personnelles réelles avant d'ajouter ces protections.** Le front-end essaie l'API au démarrage et revient en mode démo local si elle est indisponible.


## Exécution avec Docker

Construire et démarrer une instance locale avec stockage persistant :

```bash
docker build -t petale:local .
docker run --rm -p 3000:3000 -v petale-data:/app/data petale:local
```

L'application est alors disponible sur http://localhost:3000. Le conteneur utilise l'utilisateur non privilégié `node`, expose le port 3000 et vérifie périodiquement le endpoint de santé. Le volume Docker conserve les données entre redémarrages. Pour arrêter le conteneur, utilisez `Ctrl+C` (ou arrêtez le conteneur en arrière-plan).

**Important :** le conteneur facilite l'exécution, mais ne rend pas l'application prête à être exposée sur Internet. Avant une vraie mise en production, il faut encore mettre en place l'authentification et les autorisations, une base de données transactionnelle, des sauvegardes, une configuration HTTPS et une politique de confidentialité adaptée.
