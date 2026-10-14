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
- `PATCH /api/orders/:id/status` — fait évoluer le statut d'une commande
- `GET /api/couriers` — liste de démonstration des livreurs

Le fichier de données peut être déplacé en définissant `PETAL_STORE_PATH`. Le port est configurable via `PORT`.

### Tests automatisés
```bash
npm test
```

Les tests couvrent le health check, la lecture des commandes et livreurs, la création persistante, la validation des entrées, l'assignation, les transitions de statut et le service du front-end.

### Limites et sécurité avant une mise en ligne
Ce backend est une fondation MVP, pas encore un service de production. Le stockage JSON convient à une instance de démonstration et à des essais légers, mais pas à une forte concurrence ni à plusieurs instances. Il n'y a pas encore d'authentification, d'autorisation par rôle, de base SQL, de protection CSRF/rate limiting, de journal d'audit, ni de sauvegarde automatisée. **Ne pas exposer publiquement avec des données personnelles réelles avant d'ajouter ces protections.** Le front-end essaie l'API au démarrage et revient en mode démo local si elle est indisponible.
