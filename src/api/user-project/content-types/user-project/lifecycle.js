/**
 * Fichier lifecycle.js  
 * Vérification que le couple user id et project id est unique pour éviter les doublons dans les suivis de projet par les utilisateurs.
 */
module.exports = {
  async beforeCreate(event) {
    const { user, project } = event.params.data;

    const existing = await strapi.db.query("api::user-project.user-project").findOne({
      where: {
        user: user.connect?.[0]?.id ?? user,
        project: project.connect?.[0]?.id ?? project,
      },
    });

    if (existing) {
      throw new strapi.errors.ApplicationError("Cet utilisateur suit déjà ce projet");
    }
  },
};
