// config/cron-tasks.js
'use strict';

const { syncFundingAmounts } = require('../src/scripts/import-wordpress.js');

// ── Helpers logs ──────────────────────────────────────────────────────────────
function log(cronName, status, detail = '') {
  const ts = new Date().toISOString();
  console.log(`[CRON][${ts}] ${cronName} → ${status} ${detail}`);
}

// ── Cron 1 : Sync funding amounts depuis CRM (toutes les 6h) ─────────────────
const syncFunding = {
  task: async ({ strapi }) => {
    const start = Date.now();
    log('SyncFundingAmounts', 'START');
    try {
      await syncFundingAmounts(strapi);
      log('SyncFundingAmounts', 'OK', `${Date.now() - start}ms`);
    } catch (err) {
      log('SyncFundingAmounts', 'ERREUR', `${Date.now() - start}ms — ${err.message}`);
    }
  },
  options: {
    rule: process.env.CRON_SYNC_FUNDING || '0 */6 * * *',
  },
};

// ── Cron 2 : Sync dons HelloAsso → user-projects (toutes les heures) ─────────
const syncDonsUser = {
  task: async ({ strapi }) => {
    const start = Date.now();
    log('SyncDonsUser', 'START');
    try {
      await syncDonsHelloAsso(strapi);
      log('SyncDonsUser', 'OK', `${Date.now() - start}ms`);
    } catch (err) {
      log('SyncDonsUser', 'ERREUR', `${Date.now() - start}ms — ${err.message}`);
    }
  },
  options: {
    rule: process.env.CRON_MAJ_DONS || '0 * * * *',
  },
};

// ── Logique sync dons HelloAsso ───────────────────────────────────────────────
async function syncDonsHelloAsso(strapi) {
  const FACADE_URL = process.env.API_BASE_URL || 'http://localhost:3001';

  // 1. Récupère tous les paiements HelloAsso via la façade
  log('SyncDonsUser', 'FETCH', 'récupération des paiements HelloAsso...');
  let payments;
  try {
    const resp = await fetch(`${FACADE_URL}/api/helloasso/get-dons-user-all`);
    if (!resp.ok) {
      throw new Error(`Façade HelloAsso unreachable — status ${resp.status}`);
    }
    const body = await resp.json();
    payments = body.data;
  } catch (err) {
    throw new Error(`Impossible de récupérer les paiements HelloAsso : ${err.message}`);
  }

  if (!Array.isArray(payments) || payments.length === 0) {
    log('SyncDonsUser', 'SKIP', 'aucun paiement à traiter');
    return;
  }

  log('SyncDonsUser', 'INFO', `${payments.length} paiements à traiter`);

  // 2. Récupère tous les projets Strapi indexés par crm_id = formSlug
  const projectsRaw = await strapi.entityService.findMany('api::project.project', {
    fields: ['id', 'documentId', 'crm_id', 'title'],
    limit: 10000,
  });
  const projectMap = new Map();
  for (const p of projectsRaw) {
    if (p.crm_id) projectMap.set(String(p.crm_id), p);
  }
  log('SyncDonsUser', 'INFO', `${projectMap.size} projets indexés par crm_id`);

  // 3. Récupère tous les users Strapi indexés par email
  const usersRaw = await strapi.entityService.findMany('plugin::users-permissions.user', {
    fields: ['id', 'documentId', 'email'],
    limit: 10000,
  });
  const userMap = new Map();
  for (const u of usersRaw) {
    if (u.email) userMap.set(u.email.toLowerCase(), u);
  }
  log('SyncDonsUser', 'INFO', `${userMap.size} users indexés par email`);

  // 4. Agrège les dons par (email, formSlug)
  // Structure : Map< "email|formSlug" → { total, count, userId, projectId } >
  const aggMap = new Map();
  let skipped = 0;

  for (const payment of payments) {
    const email     = payment.payer?.email?.toLowerCase();
    const formSlug  = String(payment.order?.formSlug);
    const amount    = payment.amount ?? 0;
    const state     = payment.state;

    // On ne compte que les paiements autorisés
    if (state !== 'Authorized') { skipped++; continue; }

    const user    = userMap.get(email);
    const project = projectMap.get(formSlug);

    if (!user) {
      log('SyncDonsUser', 'SKIP_USER', `email inconnu dans Strapi : ${email}`);
      continue;
    }
    if (!project) {
      log('SyncDonsUser', 'SKIP_PROJECT', `formSlug ${formSlug} sans projet correspondant`);
      continue;
    }

    const key = `${user.id}|${project.id}`;
    if (!aggMap.has(key)) {
      aggMap.set(key, {
        userId:     user.id,
        projectId:  project.id,
        total:      0,
        count:      0,
        email,
        formSlug,
      });
    }
    const entry = aggMap.get(key);
    entry.total += amount;
    entry.count += 1;
  }

  log('SyncDonsUser', 'INFO', `${skipped} paiements ignorés (non Authorized)`);
  log('SyncDonsUser', 'INFO', `${aggMap.size} paires user-projet à synchroniser`);

  // 5. Pour chaque paire, trouve ou crée la relation user-project
  let created = 0;
  let updated = 0;
  let errors  = 0;

  for (const entry of aggMap.values()) {
    try {
      // Cherche une relation existante
      const existing = await strapi.entityService.findMany('api::user-project.user-project', {
        filters: {
          user:    { id: { $eq: entry.userId    } },
          project: { id: { $eq: entry.projectId } },
        },
        limit: 1,
      });

      if (existing.length > 0) {
        // Met à jour
        await strapi.entityService.update(
          'api::user-project.user-project',
          existing[0].id,
          {
            data: {
              total_donated:  entry.total,
              donation_count: entry.count,
            },
          }
        );
        updated++;
        log('SyncDonsUser', 'UPDATE',
          `user=${entry.email} projet=${entry.formSlug} total=${entry.total}cts count=${entry.count}`
        );
      } else {
        // Crée la relation
        await strapi.entityService.create('api::user-project.user-project', {
          data: {
            user:           entry.userId,
            project:        entry.projectId,
            total_donated:  entry.total,
            donation_count: entry.count,
            liked:          false,
            followed_since: new Date().toISOString(),
          },
        });
        created++;
        log('SyncDonsUser', 'CREATE',
          `user=${entry.email} projet=${entry.formSlug} total=${entry.total}cts count=${entry.count}`
        );
      }
    } catch (err) {
      errors++;
      log('SyncDonsUser', 'ERREUR_ITEM',
        `user=${entry.email} projet=${entry.formSlug} — ${err.message}`
      );
    }
  }

  log('SyncDonsUser', 'RÉSUMÉ',
    `créés=${created} mis_à_jour=${updated} erreurs=${errors}`
  );
}

// ── Cron 3 : Vérification des seuils de financement pour notifications (toutes les heures) ─────────

const THRESHOLDS = [25, 50, 75, 100];

const fundingThresholdCheck = {
  task:  async ({ strapi }) => {
    strapi.log.info('[CRON] fundingThresholdCheck — démarrage');

    try {
      // 1. Récupère tous les projets actifs ayant un goal_amount défini
      const projects = await strapi.entityService.findMany('api::project.project', {
        filters: {
          status: 'active',
          goal_amount: { $gt: 0 },
        },
        fields: ['id', 'title', 'current_amount', 'goal_amount', 'notified_thresholds'],
      });

      strapi.log.info(`[CRON] ${projects.length} projet(s) actif(s) à vérifier`);

      for (const project of projects) {
        await checkProjectThreshold(strapi, project);
      }
    } catch (err) {
      strapi.log.error('[CRON] Erreur lors de la vérification des seuils :', err);
    }

      strapi.log.info('[CRON] fundingThresholdCheck — terminé');
    },
  options: {
    rule: process.env.CRON_FUNDING_THRESHOLD_CHECK || '*/2 * * * *',
  },
};
 
/**
 * Vérifie si un projet a franchi un nouveau seuil et envoie les notifications.
 */
async function checkProjectThreshold(strapi, project) {
  const { id, title, current_amount, goal_amount } = project;
 
  if (!goal_amount || goal_amount <= 0) return;
 
  const percentage = (current_amount / goal_amount) * 100;
 
  // Seuils déjà notifiés (tableau stocké en JSON dans la DB)
  const alreadyNotified = Array.isArray(project.notified_thresholds)
    ? project.notified_thresholds
    : [];
 
  // Seuils franchis mais pas encore notifiés
  const newThresholds = THRESHOLDS.filter(
    (t) => percentage >= t && !alreadyNotified.includes(t)
  );
 
  if (newThresholds.length === 0) return;
 
  strapi.log.info(
    `[CRON] Projet #${id} "${title}" — nouveaux seuils : ${newThresholds.join(', ')}%`
  );
 
  // 2. Trouve tous les user-projects associés à ce projet
  const userProjects = await strapi.entityService.findMany('api::user-project.user-project', {
    filters: { project: id },
    populate: { user: { fields: ['id', 'notif_push', 'fcm'] } },
  });
 
  // 3. Filtre les users ayant autorisé les notifications et possédant un token FCM
  const eligibleUsers = userProjects
    .map((up) => up.user)
    .filter((u) => u && u.notif_push === true && u.fcm);
 
  strapi.log.info(
    `[CRON] Projet #${id} — ${eligibleUsers.length} user(s) éligible(s) à notifier`
  );
 
  // 4. Envoie une notification pour chaque seuil franchi
  for (const threshold of newThresholds) {
    const notifPayload = buildNotificationPayload(title, threshold, percentage);
 
    if (eligibleUsers.length > 0) {
      const tokens = eligibleUsers.map((u) => u.fcm);
      await sendMulticastNotification(strapi, tokens, notifPayload, project.id, threshold);
    }
  }
 
  // 5. Met à jour les seuils notifiés en DB pour éviter les doublons
  const updatedThresholds = [...alreadyNotified, ...newThresholds];
  await strapi.entityService.update('api::project.project', id, {
    data: { notified_thresholds: updatedThresholds },
  });
}
 
/**
 * Construit le payload FCM selon le seuil franchi.
 */
function buildNotificationPayload(projectTitle, threshold, currentPercentage) {
  const messages = {
    25:  { title: '🎉 Premier quart atteint !',       body: `Le projet "${projectTitle}" a atteint 25% de son objectif !` },
    50:  { title: '🚀 La moitié du chemin parcourue !', body: `Le projet "${projectTitle}" est financé à 50% !` },
    75:  { title: '💪 Trois quarts atteints !',        body: `Le projet "${projectTitle}" est financé à 75% !` },
    100: { title: '🏆 Objectif atteint !',              body: `Le projet "${projectTitle}" est entièrement financé !` },
  };
 
  const { title, body } = messages[threshold] || {
    title: `Seuil ${threshold}% atteint`,
    body:  `Le projet "${projectTitle}" a franchi les ${threshold}%.`,
  };
 
  return {
    notification: { title, body },
    data: {
      type:      'funding_threshold',
      threshold: String(threshold),
      project:   projectTitle,
      percent:   String(Math.round(currentPercentage)),
    },
  };
}
 
/**
 * Envoie la notification en multicast via strapi.notification.sendToAll
 * (ou via sendNotification token par token en fallback).
 */
async function sendMulticastNotification(strapi, tokens, payload, projectId, threshold) {
  try {
    if (strapi.notification?.sendToAll) {
      // On réutilise sendToAll mais en ciblant uniquement les tokens du projet
      // => On appelle directement firebase messaging pour le multicast ciblé
      const messaging = strapi.firebase?.messaging();
      if (!messaging) {
        strapi.log.warn('[FCM] Instance Firebase non disponible');
        return;
      }
 
      // Découpe en lots de 500 (limite Firebase)
      const chunks = [];
      for (let i = 0; i < tokens.length; i += 500) {
        chunks.push(tokens.slice(i, i + 500));
      }
 
      for (const chunk of chunks) {
        const response = await messaging.sendEachForMulticast({
          tokens: chunk,
          ...payload,
        });
 
        strapi.log.info(
          `[FCM] Projet #${projectId} seuil ${threshold}% : ` +
          `${response.successCount} succès, ${response.failureCount} échecs sur ${chunk.length} tokens`
        );
 
        // Log des tokens en échec pour nettoyage éventuel
        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            strapi.log.warn(
              `[FCM] Token invalide (projet #${projectId}) : ${chunk[idx]} — ${resp.error?.code}`
            );
          }
        });
      }
    } else {

      // Fallback token par token
      for (const token of tokens) {
        strapi.notification.sendNotification(token, payload);
      }
    }
  } catch (err) {
    strapi.log.error(`[FCM] Erreur envoi multicast projet #${projectId} seuil ${threshold}% :`, err);
  }
};

module.exports = { syncFunding, syncDonsUser, fundingThresholdCheck };