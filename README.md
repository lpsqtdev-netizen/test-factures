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
