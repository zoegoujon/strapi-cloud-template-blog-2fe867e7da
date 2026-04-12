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

module.exports = { syncFunding, syncDonsUser };