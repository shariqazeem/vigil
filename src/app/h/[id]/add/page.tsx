import Link from "next/link";
import { notFound } from "next/navigation";
import { canView, currentOwner } from "@/lib/auth/session";
import { getHousehold, listThings } from "@/lib/db/vigil";
import "../../../new/new.css";

export const dynamic = "force-dynamic";

/** Another thing for the watch. The same drop as a new household, pointed at an existing one. */
export default async function Add({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const household = getHousehold(id);
  if (!household) notFound();
  const owner = await currentOwner();
  if (!canView(household.ownerKey, owner)) notFound();
  const things = listThings(id);

  return (
    <main className="nw">
      <p className="nw-eyebrow mono">
        <Link href="/">vigil</Link> / <Link href={`/h/${id}`}>{household.name}</Link> / add
      </p>
      <h1 className="nw-h1 serif">What else is in there?</h1>
      <p className="nw-lede">
        Vigil is already watching {things.length} thing{things.length === 1 ? "" : "s"} here. Anything you add gets checked on the
        next watch, and on every one after that.
      </p>

      <form className="nw-form" method="post" action={`/api/households/${id}/things`} encType="multipart/form-data">
        <label className="nw-field">
          <span className="nw-k">What to add</span>
          <textarea name="text" rows={5} maxLength={12000} placeholder={"A Lasko 755320 tower heater in the hall.\nGraco 4Ever DLX car seat, bought second-hand."} />
        </label>
        <div className="nw-row">
          <label className="nw-field">
            <span className="nw-k">VIN <em>optional</em></span>
            <input name="vin" maxLength={24} spellCheck={false} className="mono" />
          </label>
          <label className="nw-field">
            <span className="nw-k">Or a photo <em>optional</em></span>
            <input type="file" name="photo" accept="image/png,image/jpeg,image/webp" />
          </label>
        </div>
        <button type="submit" className="btn nw-go">Add to the watch</button>
      </form>
    </main>
  );
}
