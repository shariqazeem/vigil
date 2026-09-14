import Link from "next/link";
import "./new.css";

export const metadata = { title: "Tell Vigil what is in your home" };

/**
 * The drop. The whole of onboarding: say what you own, in whatever shape it comes out.
 *
 * The examples matter more than the form does. People do not know that a dresser is a recallable
 * object, or that a recall notice is scoped to a manufacture window, so the placeholder teaches by
 * being an ordinary sentence about ordinary things rather than a schema.
 */
export default function New() {
  return (
    <main className="nw">
      <p className="nw-eyebrow mono">
        <Link href="/">vigil</Link> / new watch
      </p>
      <h1 className="nw-h1 serif">What&rsquo;s in your home?</h1>
      <p className="nw-lede">
        Anything a safety regulator could ever issue a notice about: the car, the cot, the dresser, the heater, the baby monitor,
        what&rsquo;s in the medicine drawer. Write it the way you&rsquo;d say it. Vigil works out the rest, and asks rather than guesses.
      </p>

      <form className="nw-form" method="post" action="/api/households" encType="multipart/form-data">
        <label className="nw-field">
          <span className="nw-k">What to call this home</span>
          <input name="name" placeholder="Our flat" maxLength={80} />
        </label>

        <label className="nw-field">
          <span className="nw-k">What&rsquo;s in it</span>
          <textarea
            name="text"
            rows={7}
            maxLength={12000}
            placeholder={`We've got a 2019 Honda Accord.
Ayesha's room has a Mainstays 9-drawer fabric dresser — my sister gave it to us, so I don't know how old it is.
There's a Babysense Max View VBM55 baby monitor next to the cot.
And vitafusion melatonin gummies in the kitchen drawer.`}
          />
        </label>

        <div className="nw-row">
          <label className="nw-field">
            <span className="nw-k">
              VIN, if you have one <em>optional</em>
            </span>
            <input name="vin" placeholder="1HGCV1F34KA000000" maxLength={24} spellCheck={false} className="mono" />
            <span className="nw-hint">Decoded by NHTSA itself, never guessed at.</span>
          </label>

          <label className="nw-field">
            <span className="nw-k">
              Or a photo <em>optional</em>
            </span>
            <input type="file" name="photo" accept="image/png,image/jpeg,image/webp" />
            <span className="nw-hint">A shelf, a box, a receipt, a label.</span>
          </label>
        </div>

        <button type="submit" className="btn nw-go">
          Start watching
        </button>

        <p className="nw-fine">
          No account. The watch belongs to whoever holds the cookie this sets. Vigil reads public federal safety data — it never
          sends anything to anyone, and it never speaks for you: if it wants to tell someone else, it stops and asks first.
        </p>
      </form>
    </main>
  );
}
