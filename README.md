# Strapi Cloud

## 1. Structure du dépôt

- `config/` : configuration Strapi (serveur, base de données, plugins, middlewares)
- `data/` : données d’import et fichiers statiques
- `database/` : migrations et configuration de la base
- `public/` : assets publics
- `scripts/` : scripts utilitaires (notamment l’import WordPress)
- `src/` : code Strapi (bootstrap, API, admin, extensions)
- `types/` : définitions de types générées

## 2. Prérequis

Avant de commencer, installez :

- Node.js **20** ou **22**
- npm
- Docker
- Git

## 3. Cloner le dépôt

```bash
git clone https://github.com/zoegoujon/strapi-cloud-template-blog-2fe867e7da.git
cd strapi-cloud-template-blog-2fe867e7da
```

## 4. Installer les dépendances

```bash
npm install
```

## 5. Lancer PostgreSQL avec Docker

Dans un terminal, démarrez PostgreSQL :

```bash
docker run --name strapi-postgres \
  -e POSTGRES_USER=chuchoteurs \
  -e POSTGRES_PASSWORD=Chuch0teursDB. \
  -e POSTGRES_DB=strapi_db \
  -p 5433:5432 \
  -d postgres
```

Puis vérifiez que le conteneur est bien démarré :

```bash
docker ps
```

Si le conteneur n’est pas en état `UP`, Strapi ne pourra pas démarrer.

> Les erreurs `127.0.0.1` au lancement de Strapi sont souvent dues à un conteneur PostgreSQL Docker non démarré.

## 6. Configurer le token Strapi

Après avoir lancé Strapi, ouvrez l’interface d’administration web et allez dans :

- **Paramètres** → **API Token**

Générez un token avec :

- Nom : libre
- Durée : `unlimited`
- Permissions : `full-access`

Copiez le token. Il ne sera plus affiché après création.

Ensuite, collez ce token dans le fichier `.env` de l’API façade, en remplaçant la valeur de `STRAPI_API_TOKEN`.

## 7. Importer les données WordPress

Pour charger les données réelles issues du fichier XML WordPress dans Strapi, exécutez :

```bash
node scripts/debug-import.js
```

Lancez cette commande depuis un autre terminal dans le dossier Strapi.

## 8. Lancer Strapi localement

```bash
npm run develop
```

Au premier démarrage, Strapi vous demandera de créer un compte administrateur.

## 9. Bonnes pratiques

- Vérifiez toujours que le conteneur PostgreSQL est démarré avant de lancer Strapi.
- Si vous modifiez des modèles, committez les fichiers de configuration Strapi (`src/api/<content-type>/...`).
- Pour partager des données, utilisez l’export/import PostgreSQL plutôt que de dupliquer manuellement les contenus.

## 10. Commandes utiles

- Installer les dépendances : `npm install`
- Lancer Strapi : `npm run develop`
- Importer les données WordPress : `node scripts/debug-import.js`
- Vérifier Docker : `docker ps`
- Supprimer le conteneur PostgreSQL : `docker rm -f strapi-postgres`