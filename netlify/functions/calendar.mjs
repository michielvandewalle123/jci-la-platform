// JCI Vlaanderen LA-platform — persoonlijke iCal-feed (read-only).
// Endpoint: /.netlify/functions/calendar?token=<persoonlijk token>
// Levert de lokale AV's waarop de gebruiker aanwezig staat (DB.visits,
// by===user, status != afgelast) als iCalendar-feed. Eénrichting: app → agenda.
import { getStore } from "@netlify/blobs";

function icsEsc(s){
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}
function pad(n){ return String(n).padStart(2, "0"); }
function dstamp(){
  const d = new Date();
  return d.getUTCFullYear() + pad(d.getUTCMonth()+1) + pad(d.getUTCDate())
    + "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + "Z";
}
// RFC 5545: regels vouwen op ~75 octets met CRLF + spatie.
function fold(line){
  if (line.length <= 73) return line;
  let out = "", s = line;
  while (s.length > 73){ out += s.slice(0,73) + "\r\n "; s = s.slice(73); }
  return out + s;
}

export function buildIcs(visits, avs, label){
  const avByKey = {};
  (avs || []).forEach(a => { avByKey[a.afdeling + "|" + a.datum] = a; });
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//JCI Vlaanderen//LA-platform//NL",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:" + icsEsc(label),
    "NAME:" + icsEsc(label),
    "X-WR-TIMEZONE:Europe/Brussels",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H"
  ];
  const stamp = dstamp();
  (visits || []).forEach(v => {
    if (!v || !v.datum || v.status === "afgelast") return;
    const ymd = String(v.datum).replace(/-/g, "");
    if (ymd.length !== 8) return;
    const av = avByKey[v.afdeling + "|" + v.datum] || {};
    const uur = String(v.uur || av.uur || "").trim();
    const ev = [
      "BEGIN:VEVENT",
      "UID:" + icsEsc((v.id || (v.afdeling + v.datum)) + "@jci-la-platform"),
      "DTSTAMP:" + stamp
    ];
    const m = uur.match(/^(\d{1,2})[:hu.](\d{2})/);
    if (m){
      const hh = pad(parseInt(m[1],10)), mm = pad(parseInt(m[2],10));
      const Y = parseInt(ymd.slice(0,4),10), Mo = parseInt(ymd.slice(4,6),10), D = parseInt(ymd.slice(6,8),10);
      const end = new Date(Y, Mo-1, D, parseInt(hh,10), parseInt(mm,10));
      end.setHours(end.getHours() + 2); // standaardduur 2u
      const endLocal = end.getFullYear() + pad(end.getMonth()+1) + pad(end.getDate())
        + "T" + pad(end.getHours()) + pad(end.getMinutes()) + "00";
      ev.push("DTSTART:" + ymd + "T" + hh + mm + "00"); // floating local time
      ev.push("DTEND:" + endLocal);
    } else {
      const dd = new Date(parseInt(ymd.slice(0,4),10), parseInt(ymd.slice(4,6),10)-1, parseInt(ymd.slice(6,8),10));
      dd.setDate(dd.getDate() + 1);
      const next = dd.getFullYear() + pad(dd.getMonth()+1) + pad(dd.getDate());
      ev.push("DTSTART;VALUE=DATE:" + ymd);
      ev.push("DTEND;VALUE=DATE:" + next);
    }
    ev.push("SUMMARY:" + icsEsc("AV " + (v.afdeling || "")));
    let loc = av.locatie || "";
    if (av.adres) loc = loc ? (loc + ", " + av.adres) : av.adres;
    if (loc) ev.push("LOCATION:" + icsEsc(loc));
    const desc = [];
    if (v.status) desc.push("Status: " + v.status);
    if (v.notities) desc.push(v.notities);
    if (desc.length) ev.push("DESCRIPTION:" + icsEsc(desc.join(" — ")));
    ev.push("STATUS:CONFIRMED");
    ev.push("END:VEVENT");
    lines.push(...ev);
  });
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token") || "";
    if (!token) return new Response("Missing token", { status: 400 });

    const store = getStore("jci-data");
    const db = await store.get("db", { type: "json" });
    if (!db) return new Response("No data", { status: 404 });

    const tokens = db.calTokens || {};
    let user = null;
    for (const email in tokens){ if (tokens[email] === token){ user = email; break; } }
    if (!user) return new Response("Invalid token", { status: 403 });

    const visits = (db.visits || []).filter(v => v.by === user);
    const ics = buildIcs(visits, db.avs || [], "JCI LA - mijn AV's");

    return new Response(ics, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
        "Content-Disposition": "inline; filename=jci-la.ics"
      }
    });
  } catch (e) {
    return new Response("Error: " + (e && e.message ? e.message : e), { status: 500 });
  }
};
