// JCI Vlaanderen LA-platform — persoonlijke iCal-feeds (read-only).
// Endpoint: /.netlify/functions/calendar?token=<token>&type=<eigen|ander|aanwezig>
// Per type wordt server-side het recht gecontroleerd:
//   eigen    -> AV's van de eigen afdeling           (recht avEigen ro)
//   ander    -> AV's van andere afdelingen           (recht avAnder ro)
//   aanwezig -> AV's waarop de gebruiker aanwezig is   (recht agenda ro; uit DB.visits)
// Eénrichting: app -> agenda.
import { getStore } from "@netlify/blobs";

// Fallback-rechten — spiegelt de relevante sleutels van DEFAULT_RECHTEN in index.html.
// Bij een aangepaste rechtentabel wordt DB.rechten[rol] gebruikt (volledig live).
const DEFAULT_RECHTEN = {
  admin:        { all: 2 },
  bestuur:      { avEigen: 2, avAnder: 2, agenda: 1 },
  vz:           { avEigen: 2, avAnder: 1, agenda: 1 },
  localBestuur: { avEigen: 1, avAnder: 1, agenda: 1 },
  lid:          { avEigen: 1, avAnder: 0, agenda: 0 }
};
export function rechtFor(db, role){
  return (db.rechten && db.rechten[role]) ? db.rechten[role] : (DEFAULT_RECHTEN[role] || {});
}
export function hasR(r, module, min){
  if (r && r.all === 2) return true;
  const raw = r ? r[module] : undefined;
  const v = raw === 'rw' ? 2 : raw === 'ro' ? 1 : (raw !== undefined ? Number(raw) : 0);
  return min === 'rw' ? v >= 2 : v >= 1;
}
// Rol + eigen afdeling afleiden (spiegelt de login-logica in index.html).
export function resolveUser(db, email){
  const e = String(email || '').toLowerCase();
  const admins = (db.admins || []).map(x => String(x).toLowerCase());
  if (e === 'admin@jci.be' || admins.includes(e)) return { role: 'admin', afd: null };
  const bestuur = (db.bestuur || []).map(x => String(x).toLowerCase());
  if (bestuur.includes(e)) return { role: 'bestuur', afd: null };
  const lb = db.localBestuur || {};
  for (const afd in lb){ const arr = lb[afd]; if (Array.isArray(arr) && arr.some(m => m && m.email && String(m.email).toLowerCase() === e)) return { role: 'localBestuur', afd }; }
  const vz = db.vz || {};
  for (const afd in vz){ const v = vz[afd]; if (v && v.email && String(v.email).toLowerCase() === e) return { role: 'vz', afd }; }
  return { role: 'lid', afd: null };
}

function icsEsc(s){ return String(s == null ? "" : s).replace(/\\/g,"\\\\").replace(/;/g,"\\;").replace(/,/g,"\\,").replace(/\r?\n/g,"\\n"); }
function pad(n){ return String(n).padStart(2, "0"); }
function dstamp(){ const d=new Date(); return d.getUTCFullYear()+pad(d.getUTCMonth()+1)+pad(d.getUTCDate())+"T"+pad(d.getUTCHours())+pad(d.getUTCMinutes())+pad(d.getUTCSeconds())+"Z"; }
function fold(line){ if(line.length<=73) return line; let out="",s=line; while(s.length>73){ out+=s.slice(0,73)+"\r\n "; s=s.slice(73); } return out+s; }

// item: {id, afdeling, datum(YYYY-MM-DD), uur?, locatie?, adres?, status?, notities?}
function eventLines(item, stamp){
  if (!item || !item.datum) return [];
  const ymd = String(item.datum).replace(/-/g, "");
  if (ymd.length !== 8) return [];
  const uur = String(item.uur || "").trim();
  const lines = ["BEGIN:VEVENT", "UID:" + icsEsc((item.id || (item.afdeling + item.datum)) + "@jci-la-platform"), "DTSTAMP:" + stamp];
  const m = uur.match(/^(\d{1,2})[:hu.](\d{2})/);
  if (m){
    const hh = pad(parseInt(m[1],10)), mm = pad(parseInt(m[2],10));
    const end = new Date(parseInt(ymd.slice(0,4),10), parseInt(ymd.slice(4,6),10)-1, parseInt(ymd.slice(6,8),10), parseInt(hh,10), parseInt(mm,10));
    end.setHours(end.getHours() + 2);
    lines.push("DTSTART:" + ymd + "T" + hh + mm + "00");
    lines.push("DTEND:" + end.getFullYear()+pad(end.getMonth()+1)+pad(end.getDate())+"T"+pad(end.getHours())+pad(end.getMinutes())+"00");
  } else {
    const dd = new Date(parseInt(ymd.slice(0,4),10), parseInt(ymd.slice(4,6),10)-1, parseInt(ymd.slice(6,8),10));
    dd.setDate(dd.getDate() + 1);
    lines.push("DTSTART;VALUE=DATE:" + ymd);
    lines.push("DTEND;VALUE=DATE:" + dd.getFullYear()+pad(dd.getMonth()+1)+pad(dd.getDate()));
  }
  lines.push("SUMMARY:" + icsEsc("AV " + (item.afdeling || "")));
  let loc = item.locatie || "";
  if (item.adres) loc = loc ? (loc + ", " + item.adres) : item.adres;
  if (loc) lines.push("LOCATION:" + icsEsc(loc));
  const desc = [];
  if (item.status) desc.push("Status: " + item.status);
  if (item.notities) desc.push(item.notities);
  if (desc.length) lines.push("DESCRIPTION:" + icsEsc(desc.join(" — ")));
  lines.push("STATUS:CONFIRMED", "END:VEVENT");
  return lines;
}
export function buildIcs(items, label){
  const lines = ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//JCI Vlaanderen//LA-platform//NL","CALSCALE:GREGORIAN","METHOD:PUBLISH",
    "X-WR-CALNAME:"+icsEsc(label),"NAME:"+icsEsc(label),"X-WR-TIMEZONE:Europe/Brussels","REFRESH-INTERVAL;VALUE=DURATION:PT6H","X-PUBLISHED-TTL:PT6H"];
  const stamp = dstamp();
  (items || []).forEach(it => { const ev = eventLines(it, stamp); if (ev.length) lines.push(...ev); });
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token") || "";
    const type = (url.searchParams.get("type") || "aanwezig").toLowerCase();
    if (!token) return new Response("Missing token", { status: 400 });

    const store = getStore("jci-data");
    const db = await store.get("db", { type: "json" });
    if (!db) return new Response("No data", { status: 404 });

    const tokens = db.calTokens || {};
    let user = null;
    for (const email in tokens){ if (tokens[email] === token){ user = email; break; } }
    if (!user) return new Response("Invalid token", { status: 403 });

    const { role, afd } = resolveUser(db, user);
    const rights = rechtFor(db, role);
    const avs = db.avs || [];
    let items, label;

    if (type === "eigen"){
      if (!afd || !hasR(rights, "avEigen", "ro")) return new Response("Forbidden", { status: 403 });
      items = avs.filter(a => a.afdeling === afd);
      label = "JCI \u2013 AV's " + afd;
    } else if (type === "ander"){
      if (!hasR(rights, "avAnder", "ro")) return new Response("Forbidden", { status: 403 });
      items = avs.filter(a => a.afdeling !== afd);
      label = "JCI \u2013 AV's andere afdelingen";
    } else { // aanwezig
      if (!hasR(rights, "agenda", "ro")) return new Response("Forbidden", { status: 403 });
      const avByKey = {};
      avs.forEach(a => { avByKey[a.afdeling + "|" + a.datum] = a; });
      items = (db.visits || []).filter(v => v.by === user && v.status !== "afgelast").map(v => {
        const a = avByKey[v.afdeling + "|" + v.datum] || {};
        return { id: v.id, afdeling: v.afdeling, datum: v.datum, uur: v.uur || a.uur || "", locatie: a.locatie || "", adres: a.adres || "", status: v.status, notities: v.notities };
      });
      label = "JCI \u2013 AV's waar ik aanwezig ben";
    }

    const ics = buildIcs(items, label);
    return new Response(ics, { status: 200, headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "Content-Disposition": "inline; filename=jci-la.ics"
    }});
  } catch (e) {
    return new Response("Error: " + (e && e.message ? e.message : e), { status: 500 });
  }
};
