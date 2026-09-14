import { cpscRecent } from "../../src/lib/sources/cpsc";
import { openFdaEnforcement } from "../../src/lib/sources/openfda";
const res = await cpscRecent("2024-06-01");
for (const n of ["26522","26307","26726"]) {
  const r = res.rows.find(x => x.recallNumber === n);
  if (!r) { console.log(n, "not found"); continue; }
  console.log("\n=== " + n + " " + (r.recallDate??"").slice(0,10) + " ===");
  console.log("TITLE:", r.title);
  console.log("DESC:", r.description);
  console.log("HAZARDS:", JSON.stringify(r.hazards));
  console.log("REMEDIES:", JSON.stringify(r.remedies));
  console.log("INJURIES:", JSON.stringify(r.injuries).slice(0,400));
  console.log("PRODUCTS:", JSON.stringify(r.products).slice(0,400));
  console.log("URL:", r.url);
}
for (const t of [["food",["infant formula"]],["food",["melatonin"]],["food",["baby food"]],["drug",["ibuprofen"]],["food",["cinnamon"]]] as const) {
  const f = await openFdaEnforcement({ area: t[0], terms: [...t[1]], limit: 3 });
  console.log(`\nopenFDA ${t[0]} ${t[1]}: ok=${f.ok} rows=${f.rowCount} ${f.error??""}`);
  for (const r of f.rows.slice(0,2)) console.log(`   ${r.recallNumber} ${r.classification} · ${(r.productDescription??"").slice(0,90)} · ${(r.reasonForRecall??"").slice(0,90)}`);
}
