# Projet Strapi – Mise en place pour les développeurs

Ce guide explique comment installer et lancer le projet Strapi localement avec une base PostgreSQL, pour tous les membres de l'équipe.

---

## 1. Prérequis

Avant de commencer, assurez-vous d’avoir installé :

- Node.js (v18 ou v20 recommandée)
- npm
- Docker
- Git

---

## 2. Cloner le projet

```bash
git clone <URL_DU_REPO> my-strapi-project
cd my-strapi-project
git checkout main

Remplacez <URL_DU_REPO> par l’URL GitHub ou GitLab du projet.
```

## 3. Installer les dépendances Node.js

```bash
npm install
```

---

## 4. Lancer PostgreSQL avec Docker

Créez un container PostgreSQL pour le projet :

``` bash
docker run --name strapi-postgres \
  -e POSTGRES_USER=strapi_user \
  -e POSTGRES_PASSWORD=motdepasse \
  -e POSTGRES_DB=strapi \
  -p 5432:5432 \
  -d postgres
```

strapi_user : utilisateur PostgreSQL

motdepasse : mot de passe

strapi : nom de la base

Vérifiez que le container tourne :

docker ps

---

## 5. Configurer Strapi pour PostgreSQL

Créez ou modifiez le fichier ./config/env/development/database.js :

```js
module.exports = ({ env }) => ({
  connection: {
    client: 'postgres',
    connection: {
      host: env('DATABASE_HOST', '127.0.0.1'),
      port: env.int('DATABASE_PORT', 5432),
      database: env('DATABASE_NAME', 'strapi'),
      user: env('DATABASE_USERNAME', 'strapi_user'),
      password: env('DATABASE_PASSWORD', 'motdepasse'),
      ssl: env.bool('DATABASE_SSL', false),
    },
    debug: false,
  },
});
```

Créez un fichier .env à la racine (ne pas versionner) :

``` .env
DATABASE_CLIENT=postgres
DATABASE_HOST=127.0.0.1
DATABASE_PORT=5432
DATABASE_NAME=strapi
DATABASE_USERNAME=strapi_user
DATABASE_PASSWORD=motdepasse
DATABASE_SSL=false

ADMIN_JWT_SECRET=<une_chaine_tres_secrete_generée>
```

Générez le secret avec :

```bash
openssl rand -hex 32
```

---

## 6. Lancer Strapi

```bash
npm run develop
```

La première fois, Strapi demandera de créer un compte admin.

Ensuite, vous pourrez vous connecter normalement.

---

## 7. Ajouter ou modifier des collections

Utilisez Content-Types Builder dans l’admin panel.

Pour versionner les changements, committez les fichiers JSON :

src/api/<nom-collection>/content-types/<nom-collection>/schema.json
src/api/<nom-collection>/controllers/*
src/api/<nom-collection>/services/*

Ne modifiez jamais PostgreSQL directement pour créer les tables ou relations.

---
## 8. Workflow Git pour l’équipe

Un développeur crée/modifie un content type.

Commit et push des fichiers JSON et controllers/services.

Les autres devs font git pull.

Lancement de Strapi (npm run develop) : Strapi applique les modifications sur leur base locale.

Les données ne sont pas synchronisées automatiquement. Pour partager les données :

### Exporter
```bash
pg_dump -U strapi_user -h localhost strapi > dump_strapi.sql
```

### Importer
```bash
docker exec -i strapi-postgres psql -U strapi_user -d strapi < dump_strapi.sql
```

---

## 9. Points importants

Chaque développeur utilise sa propre base PostgreSQL locale pour le développement.

Ne pas versionner .env ni secrets JWT.

Pour partager une base commune, utilisez la même instance PostgreSQL et le même ADMIN_JWT_SECRET.

---

## 10. Ressources utiles

Documentation Strapi v4

Docker PostgreSQL