const fs = require("fs");
const { XMLParser } = require("fast-xml-parser");
const he = require("he");
const path = require("path");
const { Readable } = require('stream');
const os = require('os');


const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: true,
  trimValues: true
});

const tagCache = new Map();


// remove HTML tags from string
function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").trim();
}

function getFilenameFromUrl(url) {
  const cleanUrl = url.split("?")[0];
  return path.basename(cleanUrl);
}

// safe wrapper around he.decode that can deal with various parser outputs
function decodeXmlString(raw) {
  // convert to plain string before decoding, then trim
  let str = "";
  if (typeof raw === "string") {
    str = raw;
  } else if (raw && typeof raw["#text"] === "string") {
    str = raw["#text"];
  } else if (raw && typeof raw["#cdata"] === "string") {
    str = raw["#cdata"];
  } else if (typeof raw === "number") {
    str = raw.toString();
  }
  const decoded = he.decode(str).trim();
  return decoded;
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
  ];

  for (const field of fields) {
    if (["crm_id", "goal_amount", "current_amount", "thumbnail"].includes(field)) {
      const existingNum = Number(existing[field] ?? 0);
      const incomingNum = Number(incoming[field] ?? 0);
      if (existingNum !== incomingNum) {
        return true;
      }
      continue;
    }

    if ((existing[field] || "") !== (incoming[field] || "")) {
      return true;
    }
  }

  return false;
}

function tagsChanged(existingTags = [], newTagIds = []) {
  const existingIds = existingTags.map(t => t.id).sort();
  const incomingIds = [...newTagIds].sort();

  return JSON.stringify(existingIds) !== JSON.stringify(incomingIds);
}

async function getOrCreateTag(strapi, name, type) {
    const key = `${name}-${type}`;

if (tagCache.has(key)) {
  return tagCache.get(key);
}

  const existing = await strapi.entityService.findMany('api::tag.tag', {
    filters: { nom: name, type: type },
    limit: 1
  });

  if (existing.length > 0) {
    return existing[0].id;
  }

  const created = await strapi.entityService.create('api::tag.tag', {
    data: {
      nom: name,
      type: type
    }
  });
  tagCache.set(key, created.id);


  return created.id;
}

async function importWordpress(strapi, xmlPath, { dryRun = false } = {}) {

  const xml = fs.readFileSync(xmlPath, "utf8");
  const data = parser.parse(xml);

  const items = data.rss.channel.item;
  // build thumbnail map from attachments before processing projects
  const thumbMap = {};
  if (Array.isArray(items)) {
    for (const it of items) {
      if (it["wp:post_type"] === "attachment") {
        const parent = it["wp:post_parent"];
        // there are two possible fields: attachment_url or link
        const url = decodeXmlString(it["wp:attachment_url"] || it.link || "");
        if (parent && url) {
          thumbMap[parent] = url;
        }
      }
    }
  }

  // only process behaviours
  for (const item of items) {
    if (item["wp:post_type"] !== "projet") {
      continue; // skip non-project entries
    }

    const wordpressId = item["wp:post_id"];
    const title = decodeXmlString(item.title);

    let description = "";
    let status = "active";

    const postMeta = Array.isArray(item["wp:postmeta"])
      ? item["wp:postmeta"]
      : [item["wp:postmeta"]];

    let helloassoId = null;
    let goal_amount = null;
    let current_amount = null;
    let temporalite = "annuel";

    let sections = {};
    let faq = [];
    let thanks = [];

    for (const meta of postMeta) {
      const key = meta["wp:meta_key"];
      let rawVal = meta["wp:meta_value"];
      let value = decodeXmlString(rawVal);

      if (value==="0" || value==="h2"){
        //console.log("key à rejetée", key);
        //console.log(!value, value.startsWith("field_"), key.includes("options"), key.includes("espacement"), key.includes("enabled"))
      }

      // Skip empty/null values and ACF field keys (e.g. "field_..." values)
      if (!value || value.startsWith("field_") || key.includes("options") || key.includes("espacement") || key.includes("enabled")) {
        //console.log("key rejetée", key)
        continue;
      }
      // we already trimmed during decode so nothing else needed

      // DESCRIPTION
      if (key === "projet_intro") {
        description = value;
      }

      // HELLOASSO
      if (key === "projet_helloasso") {
        const num = Number(value);
        helloassoId = Number.isFinite(num) ? num : null;
      }

      // AMOUNTS
      if (["projet_recolte", "projet_finance", "projet_helloasso", "projet_type"].includes(key)) {
      }

      if (key === "projet_recolte") {
        const num = Number(value);
        current_amount = Number.isFinite(num) ? num : null;
      }

      // STATUS
      if (key === "projet_temporalite" && value.includes("financé")) {
        status = "funded";
      }

      if (key === "projet_type" && value.includes("pluriannuel")){
        temporalite = "pluriannuel"
      }

      if (key === "projet_finance") {
        const num = Number(value);
        goal_amount = Number.isFinite(num) ? num : null;
      }

      if (key === "projet_helloasso") {
        const num = Number(value);
        helloassoId = Number.isFinite(num) ? num : null;
      }

    if (value==="0" || value === "h1" || value === "h2" || value === "h3" || value === "h4") {
      continue;
    }

      // MATCH SECTIONS
      const sectionMatch = key?.match(/sections_(\d+)_(.*)/);

      if (sectionMatch) {

        const index = sectionMatch[1];
        const field = sectionMatch[2];

        if (!sections[index]) {
          sections[index] = {};
        }

        sections[index][field] = value;

        continue;
      }

      // FAQ
      if (key?.includes("?") || key?.includes("faq_")) {

        const faqMatch = key.match(/faq_(\d+)_(.*)/);

        if (faqMatch) {

          const index = faqMatch[1];
          const field = faqMatch[2];

          if (!faq[index]) faq[index] = {};

          faq[index][field] = value;
        }
      }

      // REMERCIEMENTS
      if (key?.includes("Merci") || key?.includes("remerciement")) {
        thanks.push(value);
      }
    }

    // ---------- PARSE SECTIONS FOR FAQs & THANKS ----------
    // Extract FAQ from sections (keys containing "?" or "titre" that end in "texte")
    const faqSet = new Set(); // track questions to avoid duplication
    const thanksSet = new Set();
    
    for (const sectionIndex in sections) {
      const section = sections[sectionIndex];

      for (const key in section) {
        const value = section[key];

        // THANKS: check for "participés au projet"
        if (value.includes("participés au projet") || value.includes("participé au projet") || value.includes("Merci") || value.includes("participés à ce projet")) {
          thanks.push(stripHtml(value));
          thanksSet.add(stripHtml(value));
        }

        // FAQ: if key contains "titre" and value has "?", pair it with the "texte" variant
        if (key.includes("titre") && value.includes("?")) {
          const textKey = key.replace("titre", "texte");
          const faqTextValue = section[textKey] || "";
          faqSet.add(stripHtml(value));
          faq.push({
            question: stripHtml(value),
            reponse: stripHtml(faqTextValue)
          });
        }
      }
    }

    // ---------- GENERATE MARKDOWN CONTENT ----------

    let contentParts = [];
    const sortedSections = Object.keys(sections).sort((a, b) => Number(a) - Number(b));

    for (const i of sortedSections) {
      const section = sections[i];
      
      const isFirstSection = i === "1";
      const isFaqTitleSection = i === "7";
      const isThanksSection = i === "11" || i === "13";
      const isFaqSection = i === "9"; // FAQ answers section, skip these
      
      if (isFaqTitleSection || isThanksSection || isFaqSection) {
        // These sections are handled elsewhere or combined into titles
        continue;
      }
      
      if (isFirstSection) {
        // First section: "Pourquoi ? Comment ?" is the main question
        // The subtitle and sub-subtitle are the answer (grouped together)
        const introTitle = section["section_soustitre_soussoutitre"]; // "Pourquoi ? Comment ?"
        const sectionsubtitle = section["section_soustitre_soutitre"]; // "Comprendre, agir & transformer"
        const subsubtitle = section["section_soustitre_deuxsoutitre"]; // "Pourquoi ce projet est essentiel !"
        
        if (introTitle) {
          contentParts.push(`## ${introTitle}`);
        }
        if (sectionsubtitle || subsubtitle) {
          contentParts.push(`**${sectionsubtitle}**`);
          if (subsubtitle) {
            contentParts.push(`**${subsubtitle}**`);
          }
        }
      } else {
        // Other sections: process titre+texte pairs
        const processed = new Set();
        
        for (const key in section) {
          if (processed.has(key)) continue;
          
          const rawValue = section[key];
          const value = stripHtml(rawValue);
          
          // Skip if in FAQ or thanks
          if (faqSet.has(value) || thanksSet.has(value)) {
            continue;
          }
          
          // Pair titre with corresponding texte
          if (key.includes("titre") && !key.includes("soussoutitre")) {
            const textKey = key.replace("titre", "texte");
            const textValue = stripHtml(section[textKey] || "");
            
            // Skip if text is in FAQ/thanks
            if (faqSet.has(textValue) || thanksSet.has(textValue)) {
              processed.add(key);
              if (section[textKey]) processed.add(textKey);
              continue;
            }
            
            contentParts.push(`### ${value}`);
            if (textValue && textValue !== value) {
              contentParts.push(textValue);
              processed.add(textKey);
            }
            processed.add(key);
          }
        }
      }
    }

    // FAQ Markdown - with combined title
    if (faq.length > 0) {
      contentParts.push("## Parce que chaque question mérite une réponse !");
      faq.forEach(q => {
        if (q.question && !q.question.includes("Pourquoi ?")) {
          contentParts.push(`### ${q.question}`);
        }
        if (q.reponse) {
          contentParts.push(q.reponse);
        }
      });
    }

    // Remerciements Markdown - with combined title
    if (thanks.length > 0) {
      contentParts.push("## Ensemble, nous faisons la différence !");
      thanks.forEach(t => {
        contentParts.push(`- ${t}`);});
    }

    const content = contentParts.join("\n\n");

    // ---------- TAGS ----------

    let tagIds = [];

if (item.category) {
  const categories = Array.isArray(item.category)
    ? item.category
    : [item.category];


  for (const cat of categories) {
    const name = decodeXmlString(cat["#text"] || cat);
    const type = cat["@_domain"] === "expertise"
      ? "expertise"
      : "category";

    
    const tagId = await getOrCreateTag(strapi, name, type);
    tagIds.push(tagId);
  }
}

    if (status === "funded"){
      current_amount = goal_amount;
    }

    const projectData = {
      // debugging
      //_debug_meta: { sections, faq, thanks, contentParts },

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
      current_amount
    };

    // attach thumbnail URL if we found one
    const thumb = thumbMap[wordpressId];
    if (thumb) {
      // store raw URL for later upload or processing
      projectData.thumbnail_url = thumb;
    }

    if (dryRun) {

      console.log("\n=======================");
      console.log("PROJECT PREVIEW");
      console.log("=======================\n");

      console.dir(projectData, { depth: null });

      continue;

    } else {

    const { Readable } = require('stream');

    console.log("Processing project:", title);
    console.log("crm_id", projectData.crm_id);

// Remplace le bloc d'upload par ceci :
if (projectData.thumbnail_url) {
  console.log("Processing thumbnail for project:", title);

  try {
    const resp = await fetch(projectData.thumbnail_url);

    if (!resp.ok) {
      console.error("Thumbnail download failed:", projectData.thumbnail_url);
    } else {
      const buffer = Buffer.from(await resp.arrayBuffer());
      const filename = getFilenameFromUrl(projectData.thumbnail_url);
      const mimeType = resp.headers.get("content-type") || "image/jpeg";
      const osTmp = os.tmpdir()
      const tempPath = `${osTmp}/${Date.now()}-${filename}`;

      fs.writeFileSync(tempPath, buffer);

      

    const uploaded = await strapi.plugin('upload').service('upload').upload({
        data: {
            fileInfo: {
            name: filename,
            caption: title,
            alternativeText: title,
            }
        },
        files: {
            originalName: filename,
            type: mimeType,
            size: buffer.length,
            filepath: tempPath,
            mimetype: mimeType,
        },
    });

      fs.unlinkSync(tempPath);

      if (uploaded && uploaded.length > 0) {
        projectData.thumbnail = uploaded[0].id;
        console.log("Thumbnail uploaded, id:", uploaded[0].id);
      }
    }
  } catch (err) {
    console.error("Thumbnail upload error:", err);
  }



    } try {

        const existing = await strapi.entityService.findMany(
            "api::project.project",
            {
                filters: { wordpress_id: wordpressId },
                populate: ["tags", "thumbnail"],
                limit: 1
            }
        );

        if (existing.length === 0) {

            console.log("CREATE:", title);

            await strapi.entityService.create(
                "api::project.project",
                {
                    data: projectData
                }
            );



        } else {

            const existingProject = existing[0];

            const hasContentChanged = projectChanged(existingProject, projectData);
            const hasTagsChanged = tagsChanged(existingProject.tags, tagIds);

            if (hasContentChanged || hasTagsChanged) {

                console.log("UPDATE:", title);

                await strapi.entityService.update(
                    "api::project.project",
                    existingProject.id,
                    {
                        data: projectData
                    }
                );

            } else {

                console.log("SKIP (no change):", title);

            }

        }

        } catch (err) {

            console.error("CREATE/UPDATE ERROR:", title);

            if (err.details?.errors) {
                for (const e of err.details.errors) {
                    console.error(
                        `Field: ${e.path} | Message: ${e.message} | Value:`,
                        e.value
                    );
                }
            } else {
                console.error(err);
            }
        }
    }
  }
}

async function syncFundingAmounts(strapi) {

  console.log("Sync funding amounts from CRM...");

  const resp = await fetch("http://localhost:3001/api/sync_funding_amount");
  const data = await resp.json();

  if (!Array.isArray(data.result)) {
    console.error("Invalid CRM response");
    return;
  }

  const crmProjects = data.result;

  // récupérer tous les projets Strapi
  const projects = await strapi.entityService.findMany(
    "api::project.project",
    {
      fields: ["id", "title", "crm_id", "goal_amount", "current_amount", "status"],
      limit: 10000
    }
  );

  // indexer les projets par crm_id
  const projectMap = new Map();

  for (const p of projects) {
    if (p.status === "funded") continue; // ne pas sync les projets déjà financés
    if (p.crm_id) {
      projectMap.set(String(p.crm_id), p);
    }
  }

  for (const crmProject of crmProjects) {

    const crmId = String(crmProject.project_number_Raw);

    if (!projectMap.has(crmId)) {
      continue;
    }

    const project = projectMap.get(crmId);

    const newGoal = crmProject.amount_target_Raw ?? 0;
    const newCurrent = crmProject.amount_current_Raw ?? 0;

    if (
      Number(project.goal_amount) !== Number(newGoal) ||
      Number(project.current_amount) !== Number(newCurrent)
    ) {

      console.log(
        `UPDATE FUNDING: ${project.title}`,
        project.current_amount,
        "→",
        newCurrent
      );

      await strapi.entityService.update(
        "api::project.project",
        project.id,
        {
          data: {
            goal_amount: newGoal,
            current_amount: newCurrent
          }
        }
      );

    }

  }

  console.log("Funding sync finished");

}

module.exports = {
  importWordpress,
  syncFundingAmounts
};