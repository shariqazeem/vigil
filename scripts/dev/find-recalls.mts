import { cpscRecent } from "../../src/lib/sources/cpsc";
const res = await cpscRecent("2024-06-01");
console.log("corpus", res.rowCount, res.ok, res.error ?? "");
const want = /crib|car seat|child restraint|stroller|high chair|space heater|portable heater|bassinet|play yard|dresser|humidifier|baby monitor|night ?light|power bank|air fryer|swing|bouncer|walker/i;
const hits = res.rows.filter(r => want.test(`${r.title} ${r.description}`));
for (const r of hits.slice(0, 45)) {
  const dated = /manufactur|date code|between|serial|lot number/i.test(r.description ?? "");
  console.log(`${r.recallNumber}  ${(r.recallDate??"").slice(0,10)}  ${dated?"[DATED]":"       "}  ${(r.title??"").slice(0,105)}`);
  console.log(`     ${(r.products.map(p=>`${p.name}/${p.model}`).join(" | ")).slice(0,130)}`);
}
console.log("total matching:", hits.length);
