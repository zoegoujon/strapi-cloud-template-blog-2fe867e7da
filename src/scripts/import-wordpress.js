/**
 * Fichier import-wordpress.js  
 */
const fs = require("fs");
const { XMLParser } = require("fast-xml-parser");
const he = require("he");
const path = require("path");
const os = require("os");

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: true,
  trimValues: true,
});

const tagCache = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fonction strip Html
 * @param {*} html - Paramètre html
 */
function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").trim();
}

/**
 * Récupère Filename From Url
 * @param {string} url - URL ou endpoint API
 */
function getFilenameFromUrl(url) {
  return path.basename(url.split("?")[0]);
}

/**
 * Fonction decode Xml String
 * @param {*} raw - Paramètre raw
 * @return {string} Chaîne décodée et nettoyée des espaces superflus. Gère les formats texte brut, CDATA, et les nombres.
 */
function decodeXmlString(raw) {
  let str = "";
  if (typeof raw === "string") {
    str = raw;
  } else if (raw && typeof raw["#text"] === "string") {
    str = raw["#text"];
  } else if (raw && typeof raw["#cdata"] === "string") {
    str = raw["#cdata"];
  } else if (typeof raw === "number") {
    str = String(raw);
  }
  return he.decode(str).trim();
}

/**
 * Fonction project Changed
 * @param {*} existing - Paramètre existing
 * @param {*} incoming - Paramètre incoming
 * @return {boolean} true si une différence est détectée sur les champs surveillés, false sinon. Les champs numériques et les URLs d'images sont comparés de manière plus tolérante.
 */
function projectChanged(existing, incoming) {
  const fields = [
    "title",
    "description",
    "content",
    "status",
    "wordpress_id",
    "crm_id",
    "goal_amount",
    "current_amount",
    "thumbnail",
    "temporalite",
    "quote_content",
    "quote_author",
    "quote_pp",
    "soustitre",
    "powerpoint",
  ];

  for (const field of fields) {
    if (["crm_id", "goal_amount", "current_amount", "thumbnail", "quote_pp"].includes(field)) {
      if (Number(existing[field] ?? 0) !== Number(incoming[field] ?? 0)) return true;
      continue;
    }
    if ((existing[field] || "") !== (incoming[field] || "")) return true;
  }
  return false;
}

/**
 * Fonction tags Changed
 * @param {*} existingTags - Paramètre existingTags
 * @param {*} newTagIds - Paramètre newTagIds
 */
function tagsChanged(existingTags = [], newTagIds = []) {
  const a = existingTags.map((t) => t.id).sort();
  const b = [...newTagIds].sort();
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * Récupère Or Create Tag
 * @param {*} strapi - Paramètre strapi
 * @param {*} name - Paramètre name
 * @param {*} type - Paramètre type
 * @return {Promise<number>} ID de la tag existante ou nouvellement créée. Utilise un cache en mémoire pour éviter les requêtes redondantes lors de l'import.
 */
async function getOrCreateTag(strapi, name, type) {
  const cacheKey = `${name}-${type}`;
  if (tagCache.has(cacheKey)) return tagCache.get(cacheKey);

  const existing = await strapi.entityService.findMany("api::tag.tag", {
    filters: { nom: name, type },
    limit: 1,
  });

  if (existing.length > 0) {
    tagCache.set(cacheKey, existing[0].id);
    return existing[0].id;
  }

  const created = await strapi.entityService.create("api::tag.tag", {
    data: { nom: name, type },
  });
  tagCache.set(cacheKey, created.id);
  return created.id;
}

// ---------------------------------------------------------------------------
// Image upload
// Skips re-upload if the existing Strapi file already has the same source URL
// stored in its `caption` field. Returns the Strapi file id to use.
// ---------------------------------------------------------------------------

/**
 * Téléverse Image
 * @param {*} strapi - Paramètre strapi
 * @param {string} url - URL ou endpoint API
 * @param {*} title - Paramètre title
 * @param {*} existingFile - Paramètre existingFile
 * @return {Promise<number|null>} ID du fichier Strapi créé ou existant, ou null si le téléchargement a échoué. Utilise le champ `caption` pour détecter les doublons basés sur l'URL source.
 */
async function uploadImage(strapi, url, title, existingFile = null) {
  if (existingFile?.caption === url) {
    console.log("  Image unchanged, reusing id:", existingFile.id);
    return existingFile.id;
  }

  const resp = await fetch(url);
  if (!resp.ok) {
    console.error("Image download failed:", url);
    return null;
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  const filename = getFilenameFromUrl(url);
  const mimeType = resp.headers.get("content-type") || "image/jpeg";
  const tempPath = path.join(os.tmpdir(), `${Date.now()}-${filename}`);

  fs.writeFileSync(tempPath, buffer);

  try {
    const uploaded = await strapi
      .plugin("upload")
      .service("upload")
      .upload({
        data: {
          // caption stores the source URL so we can detect duplicates on next sync
          fileInfo: { name: filename, caption: url, alternativeText: title },
        },
        files: {
          originalName: filename,
          type: mimeType,
          mimetype: mimeType,
          size: buffer.length,
          filepath: tempPath,
        },
      });
    const id = uploaded?.[0]?.id ?? null;
    if (id) console.log("  Image uploaded, id:", id);
    return id;
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch (unlinkErr) {
      console.warn("Could not delete temp file (non-critical):", tempPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Parse one project's postmeta
// ---------------------------------------------------------------------------

/**
 * Analyse Post Meta
 * @param {*} postMeta - Paramètre postMeta
 * @return {Object} Objet structuré avec les données extraites du postmeta, incluant description, statut, montants, URLs d'images, sections de contenu, FAQ, et remerciements. Gère les différentes conventions de nommage utilisées dans le postmeta pour organiser les données.
 */
function parsePostMeta(postMeta) {
  let description = "";
  let soustitre = null;
  let status = "active";
  let temporalite = "annuel";
  let helloassoId = null;
  let goal_amount = null;
  let current_amount = null;
  let powerpoint = null;
  let quote_content = null;
  let quote_author = null;
  let thumbnail_id = 0;
  let key_quote = "";

  const QuoteMap = {};
  const sections = {};
  const faq = [];
  const thanks = [];

  for (const meta of postMeta) {
    const key = meta["wp:meta_key"];
    const value = decodeXmlString(meta["wp:meta_value"]);

    if (key === "_thumbnail_id") {
      const num = Number(value);
      thumbnail_id = Number.isFinite(num) ? num : 0;
      continue;
    }

    if (key.includes("colimage_section_texteimage_colimage_image") && !key.startsWith("_")) {
      QuoteMap[key.replace(/^(sections_\d+)_.*$/, "$1")] = value;
    }

    if (
      !value ||
      value.startsWith("field_") ||
      key.includes("options") ||
      key.includes("espacement") ||
      key.includes("enabled")
    )
      continue;

    if (["0", "h1", "h2", "h3", "h4"].includes(value)) continue;

    if (key === "projet_intro") {
      description = value;
      continue;
    }
    if (key === "projet_subtitle") {
      soustitre = value;
      continue;
    }
    if (key.includes("canva_link")) {
      powerpoint = value;
      continue;
    }

    if (key === "projet_helloasso") {
      const num = Number(value);
      helloassoId = Number.isFinite(num) ? num : null;
      continue;
    }
    if (key === "projet_recolte") {
      const num = Number(value);
      current_amount = Number.isFinite(num) ? num : null;
      continue;
    }
    if (key === "projet_finance") {
      const num = Number(value);
      goal_amount = Number.isFinite(num) ? num : null;
      continue;
    }
    if (key === "projet_temporalite" && value.includes("financé")) {
      status = "funded";
      continue;
    }
    if (key === "projet_type" && value.includes("pluriannuel")) {
      temporalite = "pluriannuel";
      continue;
    }

    if (value.includes("blockquote")) {
      key_quote = key.replace(/^(sections_\d+)_.*$/, "$1");
      const bqMatch = value.match(/<blockquote>([\s\S]*?)<\/blockquote>/);
      const stMatch = value.match(/<strong>([\s\S]*?)<\/strong>/);
      quote_content = bqMatch ? stripHtml(bqMatch[1]).trim() : null;
      quote_author = stMatch ? stripHtml(stMatch[1]).trim() : null;
      continue;
    }

    const sectionMatch = key?.match(/sections_(\d+)_(.*)/);
    if (sectionMatch) {
      const [, index, field] = sectionMatch;
      if (!sections[index]) sections[index] = {};
      sections[index][field] = value;
      continue;
    }

    const faqMatch = key?.match(/faq_(\d+)_(.*)/);
    if (faqMatch) {
      const [, index, field] = faqMatch;
      if (!faq[index]) faq[index] = {};
      faq[index][field] = value;
      continue;
    }

    if (key?.includes("Merci") || key?.includes("remerciement")) {
      thanks.push(value);
    }
  }

  return {
    description,
    soustitre,
    status,
    temporalite,
    helloassoId,
    goal_amount,
    current_amount,
    powerpoint,
    quote_content,
    quote_author,
    thumbnail_id,
    key_quote,
    QuoteMap,
    sections,
    faq,
    thanks,
  };
}

// ---------------------------------------------------------------------------
// Build markdown content
// ---------------------------------------------------------------------------

/**
 * Construit Content
 * @param {*} sections - Paramètre sections
 * @param {*} faq - Paramètre faq
 * @param {*} thanks - Paramètre thanks
 * @return {string} Contenu formaté en markdown, structuré à partir des sections du projet, avec une FAQ et une section de remerciements. Les titres sont convertis en niveaux de heading, et les éléments de FAQ et de remerciements sont mis en avant.
 */
function buildContent(sections, faq, thanks) {
  const faqSet = new Set();
  const thanksSet = new Set();
  const faqItems = [];

  for (const sectionIndex in sections) {
    const section = sections[sectionIndex];
    for (const key in section) {
      const value = section[key];

      if (value.includes("participé") || value.includes("Merci")) {
        const clean = stripHtml(value);
        thanks.push(clean);
        thanksSet.add(clean);
      }

      if (key.includes("titre") && value.includes("?")) {
        const textKey = key.replace("titre", "texte");
        const answer = section[textKey] || "";
        faqSet.add(stripHtml(value));
        faqItems.push({ question: stripHtml(value), reponse: stripHtml(answer) });
      }
    }
  }

  const parts = [];
  const sortedSections = Object.keys(sections).sort((a, b) => Number(a) - Number(b));

  for (const i of sortedSections) {
    const section = sections[i];

    if (["7", "9", "11", "13"].includes(i)) continue;

    if (i === "1") {
      const introTitle = section["section_soustitre_soussoutitre"];
      const sectionSub = section["section_soustitre_soutitre"];
      const subsubtitle = section["section_soustitre_deuxsoutitre"];
      if (introTitle) parts.push(`## ${introTitle}`);
      if (sectionSub) parts.push(`**${sectionSub}**`);
      if (subsubtitle) parts.push(`**${subsubtitle}**`);
      continue;
    }

    const processed = new Set();
    for (const key in section) {
      if (processed.has(key)) continue;
      const value = stripHtml(section[key]);
      if (faqSet.has(value) || thanksSet.has(value)) continue;

      if (key.includes("titre") && !key.includes("soussoutitre")) {
        const textKey = key.replace("titre", "texte");
        const textValue = stripHtml(section[textKey] || "");

        if (faqSet.has(textValue) || thanksSet.has(textValue)) {
          processed.add(key);
          if (section[textKey]) processed.add(textKey);
          continue;
        }

        parts.push(`### ${value}`);
        if (textValue && textValue !== value) {
          parts.push(textValue);
          processed.add(textKey);
        }
        processed.add(key);
      }
    }
  }

  // FAQ
  if (faqItems.length > 0) {
    parts.push("## Parce que chaque question mérite une réponse !");
    for (const q of faqItems) {
      if (q.question && !q.question.includes("Pourquoi ?")) parts.push(`### ${q.question}`);
      if (q.reponse) parts.push(q.reponse);
    }
  }

  // Remerciements
  const uniqueThanks = [...new Set(thanks)];
  if (uniqueThanks.length > 0) {
    parts.push("## Ensemble, nous faisons la différence !");
    for (const t of uniqueThanks) parts.push(`- ${t}`);
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Main import
// ---------------------------------------------------------------------------

/**
 * Fonction import Wordpress
 * @param {*} strapi - Paramètre strapi
 * @param {*} xmlPath - Paramètre xmlPath
 * @param {Object} dryRun
 * @return {Promise<void>} Ne renvoie rien directement, effectue l'import des projets depuis un fichier XML exporté de WordPress. Pour chaque projet, vérifie s'il existe déjà dans Strapi en se basant sur l'ID WordPress, compare les données et les images pour décider s'il faut créer, mettre à jour, ou ignorer le projet. En mode dryRun, affiche un aperçu des données qui seraient importées sans effectuer de modifications dans Strapi.
 */
async function importWordpress(strapi, xmlPath, { dryRun = false } = {}) {
  const xml = fs.readFileSync(xmlPath, "utf8");
  const data = parser.parse(xml);
  const items = data.rss.channel.item;

  // thumbMap[post_parent][post_id] = url
  const thumbMap = {};
  if (Array.isArray(items)) {
    for (const it of items) {
      if (it["wp:post_type"] !== "attachment") continue;
      const parent = it["wp:post_parent"];
      const id = it["wp:post_id"];
      const url = decodeXmlString(it["wp:attachment_url"] || it.link || "");
      if (parent && url) {
        if (!thumbMap[parent]) thumbMap[parent] = {};
        thumbMap[parent][id] = url;
      }
    }
  }

  for (const item of items) {
    if (item["wp:post_type"] !== "projet") continue;

    const wordpressId = item["wp:post_id"];
    const title = decodeXmlString(item.title);

    const postMeta = Array.isArray(item["wp:postmeta"])
      ? item["wp:postmeta"]
      : [item["wp:postmeta"]];

    const parsed = parsePostMeta(postMeta);

    let { status, temporalite, goal_amount, current_amount } = parsed;
    const {
      description,
      soustitre,
      helloassoId,
      powerpoint,
      quote_content,
      quote_author,
      thumbnail_id,
      key_quote,
      QuoteMap,
      sections,
      faq,
      thanks,
    } = parsed;

    if (status === "funded") current_amount = goal_amount;

    const content = buildContent(sections, faq, thanks);
    const quote_pp_id = QuoteMap[key_quote];

    // Tags
    let tagIds = [];
    if (item.category) {
      const categories = Array.isArray(item.category) ? item.category : [item.category];
      for (const cat of categories) {
        const name = decodeXmlString(cat["#text"] || cat);
        const type = cat["@_domain"] === "expertise" ? "expertise" : "category";
        tagIds.push(await getOrCreateTag(strapi, name, type));
      }
    }

    const projectData = {
      title,
      description,
      content,
      temporalite,
      status,
      wordpress_id: wordpressId,
      crm_id: helloassoId,
      last_sync: new Date(),
      tags: tagIds,
      goal_amount,
      current_amount,
      quote_content,
      quote_author,
      soustitre,
      powerpoint,
    };

    const thumbUrl = thumbMap[wordpressId]?.[thumbnail_id];
    const quoteImgUrl = thumbMap[wordpressId]?.[quote_pp_id];

    if (dryRun) {
      console.log("\n=======================");
      console.log("PROJECT PREVIEW:", title);
      console.log("=======================");
      console.log("thumbnail_url :", thumbUrl ?? "(none)");
      console.log("quote_img_url :", quoteImgUrl ?? "(none)");
      console.dir(projectData, { depth: null });
      continue;
    }

    // -------------------------------------------------------------------------
    // Fetch existing project FIRST so we can compare images before uploading.
    // Everything is in one try/catch — a failure on one project never poisons
    // the PostgreSQL transaction for the next.
    // -------------------------------------------------------------------------
    try {
      console.log("Processing:", title);

      const existing = await strapi.entityService.findMany("api::project.project", {
        filters: { wordpress_id: wordpressId },
        populate: ["tags", "thumbnail", "quote_pp"],
        limit: 1,
      });

      const existingProject = existing[0] ?? null;

      if (thumbUrl) {
        const id = await uploadImage(strapi, thumbUrl, title, existingProject?.thumbnail ?? null);
        if (id) projectData.thumbnail = id;
      }

      if (quoteImgUrl) {
        const id = await uploadImage(strapi, quoteImgUrl, title, existingProject?.quote_pp ?? null);
        if (id) projectData.quote_pp = id;
      }

      if (existingProject === null) {
        console.log("  CREATE:", title);
        await strapi.entityService.create("api::project.project", { data: projectData });
      } else if (
        projectChanged(existingProject, projectData) ||
        tagsChanged(existingProject.tags, tagIds)
      ) {
        console.log("  UPDATE:", title);
        await strapi.entityService.update("api::project.project", existingProject.id, {
          data: projectData,
        });
      } else {
        console.log("  SKIP (no change):", title);
      }
    } catch (err) {
      console.error("ERROR processing project:", title);
      if (err.details?.errors) {
        for (const e of err.details.errors) {
          console.error(`  Field: ${e.path} | ${e.message} | Value:`, e.value);
        }
      } else {
        console.error(err.message ?? err);
      }
      // do NOT rethrow — continue to next project
    }
  }
}

// ---------------------------------------------------------------------------
// Sync funding amounts from CRM
// ---------------------------------------------------------------------------

/**
 * Synchronise Funding Amounts
 * @param {*} strapi - Paramètre strapi
 * @return {Promise<void>} Ne renvoie rien directement, synchronise les montants de financement des projets depuis le CRM. Récupère les données de financement via une API dédiée, compare avec les projets existants dans Strapi en se basant sur l'ID CRM, et met à jour les champs `goal_amount` et `current_amount` si des différences sont détectées. En cas d'erreur de connexion ou de données invalides, la fonction log l'erreur et quitte sans effectuer de modifications.
 */
async function syncFundingAmounts(strapi) {
  console.log("Sync funding amounts from CRM...");

  let data;
  try {
    const resp = await fetch("http://localhost:3001/api/crm/sync_funding_amount");
    if (!resp.ok) {
      console.error("CRM unreachable, status:", resp.status, "— skipping funding sync");
      return;
    }
    data = await resp.json();
  } catch (err) {
    console.error("CRM connection failed — skipping funding sync:", err.message);
    return;
  }

  if (!Array.isArray(data.result)) {
    console.error("Invalid CRM response — skipping funding sync");
    return;
  }

  const projects = await strapi.entityService.findMany("api::project.project", {
    fields: ["id", "title", "crm_id", "goal_amount", "current_amount", "status"],
    limit: 10000,
  });

  const projectMap = new Map();
  for (const p of projects) {
    if (p.status === "funded" || !p.crm_id) continue;
    projectMap.set(String(p.crm_id), p);
  }

  for (const crmProject of data.result) {
    const crmId = String(crmProject.project_number_Raw);
    if (!projectMap.has(crmId)) continue;

    const project = projectMap.get(crmId);
    const newGoal = crmProject.amount_target_Raw ?? 0;
    const newCurrent = crmProject.amount_current_Raw ?? 0;

    if (
      Number(project.goal_amount) !== Number(newGoal) ||
      Number(project.current_amount) !== Number(newCurrent)
    ) {
      console.log(`UPDATE FUNDING: ${project.title}`, project.current_amount, "->", newCurrent);
      await strapi.entityService.update("api::project.project", project.id, {
        data: { goal_amount: newGoal, current_amount: newCurrent },
      });
    }
  }

  console.log("Funding sync finished");
}

module.exports = { importWordpress, syncFundingAmounts };
