const fs = require("fs");
const { XMLParser } = require("fast-xml-parser");
const he = require("he");
const path = require("path");
const os = require("os");

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: true,
  trimValues: true
});

const tagCache = new Map();
function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").trim();
}

function getFilenameFromUrl(url) {
  return path.basename(url.split("?")[0]);
}

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
    if (["crm_id", "goal_amount", "current_amount", "thumbnail"].includes(field)) {
      if (Number(existing[field] ?? 0) !== Number(incoming[field] ?? 0)) return true;
      continue;
    }
    if ((existing[field] || "") !== (incoming[field] || "")) return true;
  }
  return false;
}

function tagsChanged(existingTags = [], newTagIds = []) {
  const a = existingTags.map((t) => t.id).sort();
  const b = [...newTagIds].sort();
  return JSON.stringify(a) !== JSON.stringify(b);
}

async function getOrCreateTag(strapi, name, type) {
  const cacheKey = `${name}-${type}`;
  if (tagCache.has(cacheKey)) return tagCache.get(cacheKey);

  const existing = await strapi.entityService.findMany("api::tag.tag", {
    filters: { nom: name, type },
    limit: 1
  });

  if (existing.length > 0) {
    tagCache.set(cacheKey, existing[0].id);
    return existing[0].id;
  }

  const created = await strapi.entityService.create("api::tag.tag", {
    data: { 
      nom: name, 
      type }
  });
  tagCache.set(cacheKey, created.id);
  return created.id;
}

// Thumbnail upload
async function uploadImage(strapi, url, title) {
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
    const uploaded = await strapi.plugin("upload").service("upload").upload({
      data: {
        fileInfo: { name: filename, caption: title, alternativeText: title },
      },
      files: {
        originalName: filename,
        type: mimeType,
        mimetype: mimeType,
        size: buffer.length,
        filepath: tempPath,
      },
    });
    return uploaded?.[0]?.id ?? null;
  } finally {
    fs.unlinkSync(tempPath);
  }
}

// Parse one project's postmeta
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

    // Thumbnail id
    if (key === "_thumbnail_id") {
      const num = Number(value);
      thumbnail_id = Number.isFinite(num) ? num : 0;
      continue;
    }

    // Quote image map
    if (key.includes("colimage_section_texteimage_colimage_image") && !key.startsWith("_")) {
      QuoteMap[key.replace(/^(sections_\d+)_.*$/, "$1")] = value;
    }

    // Skip empty / ACF field refs / noise keys
    if (
      !value ||
      value.startsWith("field_") ||
      key.includes("options") ||
      key.includes("espacement") ||
      key.includes("enabled")
    ) continue;

    // Skip heading-only values
    if (["0", "h1", "h2", "h3", "h4"].includes(value)) continue;

    // Simple scalar fields
    if (key === "projet_intro")      { description = value; continue; }
    if (key === "projet_subtitle")   { soustitre   = value; continue; }
    if (key.includes("canva_link"))  { powerpoint  = value; continue; }

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

    // Quote block
    if (value.includes("blockquote")) {
      key_quote = key.replace(/^(sections_\d+)_.*$/, "$1");
      const bqMatch = value.match(/<blockquote>([\s\S]*?)<\/blockquote>/);
      const stMatch = value.match(/<strong>([\s\S]*?)<\/strong>/);
      quote_content = bqMatch ? stripHtml(bqMatch[1]).trim() : null;
      quote_author  = stMatch ? stripHtml(stMatch[1]).trim() : null;
      continue;
    }

    // Sections
    const sectionMatch = key?.match(/sections_(\d+)_(.*)/);
    if (sectionMatch) {
      const [, index, field] = sectionMatch;
      if (!sections[index]) sections[index] = {};
      sections[index][field] = value;
      continue;
    }

    // FAQ
    const faqMatch = key?.match(/faq_(\d+)_(.*)/);
    if (faqMatch) {
      const [, index, field] = faqMatch;
      if (!faq[index]) faq[index] = {};
      faq[index][field] = value;
      continue;
    }

    // Remerciements
    if (key?.includes("Merci") || key?.includes("remerciement")) {
      thanks.push(value);
    }
  }

  return {
    description, soustitre, status, temporalite,
    helloassoId, goal_amount, current_amount, powerpoint,
    quote_content, quote_author, thumbnail_id,
    key_quote, QuoteMap,
    sections, faq, thanks,
  };
}

// ---------------------------------------------------------------------------
// Build markdown content
// ---------------------------------------------------------------------------

function buildContent(sections, faq, thanks) {
  const faqSet    = new Set();
  const thanksSet = new Set();
  const faqItems  = [];

  for (const sectionIndex in sections) {
    const section = sections[sectionIndex];
    for (const key in section) {
      const value = section[key];

      if (
        value.includes("participés au projet") ||
        value.includes("participé au projet") ||
        value.includes("Merci") ||
        value.includes("participés à ce projet")
      ) {
        const clean = stripHtml(value);
        thanks.push(clean);
        thanksSet.add(clean);
      }

      if (key.includes("titre") && value.includes("?")) {
        const textKey = key.replace("titre", "texte");
        const answer  = section[textKey] || "";
        faqSet.add(stripHtml(value));
        faqItems.push({ question: stripHtml(value), reponse: stripHtml(answer) });
      }
    }
  }

  const parts = [];
  const sortedSections = Object.keys(sections).sort((a, b) => Number(a) - Number(b));

  for (const i of sortedSections) {
    const section = sections[i];

    // Sections gérées ailleurs
    if (["7", "9", "11", "13"].includes(i)) continue;

    if (i === "1") {
      const introTitle    = section["section_soustitre_soussoutitre"];
      const sectionSub    = section["section_soustitre_soutitre"];
      const subsubtitle   = section["section_soustitre_deuxsoutitre"];
      if (introTitle)              parts.push(`## ${introTitle}`);
      if (sectionSub)              parts.push(`**${sectionSub}**`);
      if (subsubtitle)             parts.push(`**${subsubtitle}**`);
      continue;
    }

    const processed = new Set();
    for (const key in section) {
      if (processed.has(key)) continue;
      const value = stripHtml(section[key]);
      if (faqSet.has(value) || thanksSet.has(value)) continue;

      if (key.includes("titre") && !key.includes("soussoutitre")) {
        const textKey  = key.replace("titre", "texte");
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

async function importWordpress(strapi, xmlPath, { dryRun = false } = {}) {
  const xml  = fs.readFileSync(xmlPath, "utf8");
  const data = parser.parse(xml);
  const items = data.rss.channel.item;

  // Build attachment map:  thumbMap[post_parent][post_id] = url
  const thumbMap = {};
  if (Array.isArray(items)) {
    for (const it of items) {
      if (it["wp:post_type"] !== "attachment") continue;
      const parent = it["wp:post_parent"];
      const id     = it["wp:post_id"];
      const url    = decodeXmlString(it["wp:attachment_url"] || it.link || "");
      if (parent && url) {
        if (!thumbMap[parent]) thumbMap[parent] = {};
        thumbMap[parent][id] = url;
      }
    }
  }

  for (const item of items) {
    if (item["wp:post_type"] !== "projet") continue;

    const wordpressId = item["wp:post_id"];
    const title       = decodeXmlString(item.title);

    const postMeta = Array.isArray(item["wp:postmeta"])
      ? item["wp:postmeta"]
      : [item["wp:postmeta"]];

    const parsed = parsePostMeta(postMeta);

    let { status, temporalite, goal_amount, current_amount } = parsed;
    const {
      description, soustitre, helloassoId, powerpoint,
      quote_content, quote_author, thumbnail_id,
      key_quote, QuoteMap, sections, faq, thanks,
    } = parsed;

    if (status === "funded") current_amount = goal_amount;

    const content     = buildContent(sections, faq, thanks);
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
      title, description, content, temporalite, status,
      wordpress_id: wordpressId,
      crm_id: helloassoId,
      last_sync: new Date(),
      tags: tagIds,
      goal_amount, current_amount,
      quote_content, quote_author,
      soustitre, powerpoint,
    };

    // Resolve image URLs
    const thumbUrl   = thumbMap[wordpressId]?.[thumbnail_id];
    const quoteImgUrl = thumbMap[wordpressId]?.[quote_pp_id];

    if (dryRun) {
      console.log("\n=======================");
      console.log("PROJECT PREVIEW:", title);
      console.log("=======================");
      console.log("thumbnail_url :", thumbUrl   ?? "(none)");
      console.log("quote_img_url :", quoteImgUrl ?? "(none)");
      console.dir(projectData, { depth: null });
      continue;
    }

    // -----------------------------------------------------------------------
    // Upload images then upsert — wrapped in a single try/catch so a failure
    // on one project never poisons the PostgreSQL transaction for the next.
    // -----------------------------------------------------------------------
    try {
      if (thumbUrl) {
        console.log("Uploading thumbnail for:", title);
        const id = await uploadImage(strapi, thumbUrl, title);
        if (id) {
          projectData.thumbnail = id;
          console.log("Thumbnail uploaded, id:", id);
        }
      }

      if (quoteImgUrl) {
        console.log("Uploading quote image for:", title);
        const id = await uploadImage(strapi, quoteImgUrl, title);
        if (id) {
          projectData.quote_pp = id;
          console.log("Quote image uploaded, id:", id);
        }
      }

      // Upsert
      const existing = await strapi.entityService.findMany("api::project.project", {
        filters: { wordpress_id: wordpressId },
        populate: ["tags", "thumbnail"],
        limit: 1,
      });

      if (existing.length === 0) {
        console.log("CREATE:", title);
        await strapi.entityService.create("api::project.project", { data: projectData });
      } else {
        const existingProject = existing[0];
        if (projectChanged(existingProject, projectData) || tagsChanged(existingProject.tags, tagIds)) {
          console.log("UPDATE:", title);
          await strapi.entityService.update("api::project.project", existingProject.id, { data: projectData });
        } else {
          console.log("SKIP (no change):", title);
        }
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
      // Continue to next project — do NOT rethrow
    }
  }
}

// ---------------------------------------------------------------------------
// Sync funding amounts from CRM
// ---------------------------------------------------------------------------

async function syncFundingAmounts(strapi) {
  console.log("Sync funding amounts from CRM...");

  const resp = await fetch("http://localhost:3001/api/sync_funding_amount");
  const data = await resp.json();

  if (!Array.isArray(data.result)) {
    console.error("Invalid CRM response");
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

    const project   = projectMap.get(crmId);
    const newGoal   = crmProject.amount_target_Raw  ?? 0;
    const newCurrent = crmProject.amount_current_Raw ?? 0;

    if (Number(project.goal_amount) !== Number(newGoal) || Number(project.current_amount) !== Number(newCurrent)) {
      console.log(`UPDATE FUNDING: ${project.title}`, project.current_amount, "→", newCurrent);
      await strapi.entityService.update("api::project.project", project.id, {
        data: { goal_amount: newGoal, current_amount: newCurrent },
      });
    }
  }

  console.log("Funding sync finished");
}

module.exports = { importWordpress, syncFundingAmounts };