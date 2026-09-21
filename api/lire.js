/* =====================================================================
   TRENTE — /api/lire : lecture d'un immeuble par Claude (passe API)
   Décision : reconnaissance gratuite d'abord (dans le navigateur), puis
   cette passe pour ce qui résiste — titres scannés, copies de fiches
   manuscrites. La fonction télécharge les pièces du Drive avec le jeton
   de l'utilisateur (jamais le navigateur → Vercel, limite 4,5 Mo), les
   envoie à Claude en blocs document, et renvoie une PROPOSITION au format
   du contrat des analyses. Rien n'entre dans une fiche sans validation.

   Variables d'environnement (Vercel → Settings → Environment Variables) :
     ANTHROPIC_API_KEY   obligatoire
     ANTHROPIC_MODEL     facultatif, défaut ci-dessous
   ===================================================================== */
const MODELE = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
const MAX_OCTETS = 30 * 1024 * 1024;   // limite documentaire de l'API, avec marge

const CONSIGNE = `Tu es le clerc d'un notaire français chargé de l'analyse de l'origine de propriété d'un immeuble.
Tu reçois les pièces d'un dossier (titre de propriété OP/OPA, état hypothécaire ou état-réponse ANF EHF), souvent scannées : lis les images, y compris les copies de fiches manuscrites.

RÈGLE ABSOLUE : toute énonciation cite sa pièce et sa page (« 0042OP p. 12 »). Ce que tu ne lis pas, tu ne l'inventes pas : tu écris « non lu » ou « à vérifier ». Tu ne conclus jamais positivement qu'un risque est absent ; une absence de mention reste « à vérifier ».

Socle : origine trentenaire (on remonte jusqu'au premier acte translatif de plus de trente ans ; on ne s'arrête jamais sur une succession ; on s'arrête sur une expropriation, une saisie immobilière ou un aménagement foncier, qui purgent). Six contrôles par maillon : identité et capacité du disposant ; régime matrimonial et pouvoir de disposer seul ; nature du titre ; causes d'anéantissement propres ; publication au fichier immobilier (effet relatif) ; état hypothécaire (inscriptions radiées, périmées, éteintes ; prix payé). Hauts risques en carmin : donation non consolidée (924-4), donation-partage conjonctive, soulte, inaliénabilité, tontine, réméré, procédure collective, incapacité, cahier des charges de ZAC ou lotissement avec obligation en cas de vente.

Réponds UNIQUEMENT par un objet JSON, sans texte autour, de la forme :
{
 "designationTitre": [{"parcelle":"NL 113","contenance":"00 ha 14 a 29 ca","mention":"… (0042OP p. 3)"}],
 "effetRelatif": [{"parcelle":"NL 113 NL 294","formalite":"LILLE 1, 17/01/1984, vol. 6662 n° 6","nature":"Vente (0042EHF p. 5)"}],
 "chaine": [{"date":"05/12/1983","nature":"Vente","notaire":"Me X, notaire à Lille","publication":"vol. 6662 n° 6","source":"0042OP p. 2"}],
 "origine": "Paragraphe rédigé en langage d'acte, du propriétaire actuel vers l'amont, chaque fait suivi de sa source.",
 "alerteTrentenaire": null,
 "origineAnterieure": ["un maillon par entrée, avec source"],
 "servitudes": ["une par entrée, avec source"],
 "vigilance": [{"etat":"canard|orange|carmin","verification":"libellé du contrôle","conclusion":"…","sources":"0042OP p. 7"}],
 "aDemander": ["pièces ou copies d'actes à requérir, avec référence de publication quand elle est connue"],
 "extraits": [{"source":"0042EHF","page":5,"texte":"transcription littérale du passage qui fonde une énonciation"}]
}
Les dates au format JJ/MM/AAAA. Les contenances en « 00 ha 00 a 00 ca ». Le champ extraits doit contenir au moins un passage par maillon de la chaîne et par vigilance carmin.`;

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if(req.method !== "POST"){ res.status(405).end(JSON.stringify({ erreur: "POST attendu" })); return; }
  const cle = process.env.ANTHROPIC_API_KEY;
  if(!cle){ res.status(500).end(JSON.stringify({ erreur: "ANTHROPIC_API_KEY absente des variables d'environnement Vercel" })); return; }

  let corps = req.body;
  if(typeof corps === "string"){ try { corps = JSON.parse(corps); } catch(e){ corps = null; } }
  if(!corps || !corps.token || !Array.isArray(corps.pieces) || !corps.pieces.length){
    res.status(400).end(JSON.stringify({ erreur: "attendu : { token, numero, pieces:[{fileId,nom,type}] }" })); return;
  }

  /* 1. Les pièces, depuis le Drive, avec le jeton en lecture seule de l'utilisateur. */
  const documents = [], journal = [];
  let total = 0;
  for(const p of corps.pieces.slice(0, 6)){
    try {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(p.fileId)}?alt=media&supportsAllDrives=true`,
        { headers: { Authorization: "Bearer " + corps.token } });
      if(!r.ok) throw new Error("Drive " + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      total += buf.length;
      if(total > MAX_OCTETS){ journal.push(`${p.nom} : ignorée, limite de ${Math.round(MAX_OCTETS/1048576)} Mo par requête dépassée`); continue; }
      documents.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") },
        title: p.nom, context: `Pièce ${p.nom} — type ${p.type || "?"} — immeuble ${corps.numero || "?"}` });
      journal.push(`${p.nom} : ${Math.round(buf.length/1024)} ko transmis`);
    } catch(e){ journal.push(`${p.nom} : non lue — ${e.message}`); }
  }
  if(!documents.length){ res.status(502).end(JSON.stringify({ erreur: "aucune pièce téléchargeable", journal })); return; }

  /* 2. Claude. */
  const requete = {
    model: MODELE, max_tokens: 8000, temperature: 0,
    system: CONSIGNE,
    messages: [{ role: "user", content: [
      ...documents,
      { type: "text", text: `Immeuble ${corps.numero || "?"}. Pièces jointes : ${documents.map(d => d.title).join(", ")}. Produis le JSON.` } ] }],
  };
  let rep, texte;
  try {
    rep = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": cle, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(requete),
    });
    texte = await rep.text();
  } catch(e){ res.status(502).end(JSON.stringify({ erreur: "appel API : " + e.message, journal })); return; }
  if(!rep.ok){ res.status(502).end(JSON.stringify({ erreur: `API ${rep.status} : ${texte.slice(0, 400)}`, journal })); return; }

  /* 3. Le JSON, extrait de la réponse même si le modèle l'a entouré de texte. */
  let sortie = "";
  try { const j = JSON.parse(texte); sortie = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("\n"); }
  catch(e){ sortie = texte; }
  const m = sortie.match(/\{[\s\S]*\}/);
  let proposition = null;
  if(m){ try { proposition = JSON.parse(m[0]); } catch(e){ /* laissé nul */ } }
  if(!proposition){ res.status(502).end(JSON.stringify({ erreur: "réponse non exploitable", brut: sortie.slice(0, 2000), journal })); return; }
  res.status(200).end(JSON.stringify({ proposition, modele: MODELE, journal, usage: (() => { try { return JSON.parse(texte).usage; } catch(e){ return null; } })() }));
};
