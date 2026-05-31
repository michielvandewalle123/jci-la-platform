import { getStore } from "@netlify/blobs";
export default async (req, context) => {
  const store = getStore("jci-data");
  const data = await store.get("db", { type: "json" });
  return new Response(JSON.stringify(data ?? null), { headers: { "Content-Type": "application/json" } });
};
export const config = { path: "/api/getData" };
