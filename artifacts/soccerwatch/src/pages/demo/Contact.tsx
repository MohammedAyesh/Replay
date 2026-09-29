import { useState, type FormEvent } from "react";

import type { DemoCopy, Persona } from "./copy";
import { withBase } from "./data";

export function Contact({ persona, copy, whatsapp, leadsEnabled }: {
  persona: Persona;
  copy: DemoCopy["sections"]["contact"];
  whatsapp: string | null;
  leadsEnabled: boolean;
}) {
  const [name, setName] = useState("");
  const [place, setPlace] = useState("");
  const [phone, setPhone] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const whatsappUrl = whatsapp
    ? `https://wa.me/${whatsapp}?text=${encodeURIComponent(copy.whatsappMessage[persona])}`
    : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (state === "sending") return;
    setState("sending");
    try {
      const response = await fetch(withBase("/api/demo/leads"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify({ name, place, phone, persona, locale: document.documentElement.lang || "ar" }),
      });
      setState(response.ok ? "sent" : "error");
    } catch {
      setState("error");
    }
  };

  return (
    <div className="dm-contact-inner">
      {leadsEnabled && state !== "sent" && (
        <form className="dm-form" onSubmit={submit}>
          <label>
            <span>{copy.name}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoComplete="name" />
          </label>
          <label>
            <span>{copy.place[persona]}</span>
            <input value={place} onChange={(e) => setPlace(e.target.value)} required maxLength={120} autoComplete="organization" />
          </label>
          <label>
            <span>{copy.phone}</span>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              pattern="[0-9+ ()\-]{7,20}"
              dir="ltr"
            />
          </label>
          <button type="submit" className="dm-btn dm-btn--primary dm-btn--wide" disabled={state === "sending"}>
            {state === "sending" ? copy.sending : copy.send}
          </button>
          {state === "error" && <p className="dm-small dm-error" role="alert">{copy.error}</p>}
        </form>
      )}
      {state === "sent" && <p className="dm-sent" role="status">{copy.sent}</p>}
      {whatsappUrl && (
        <a className={`dm-btn dm-btn--wide ${leadsEnabled ? "dm-btn--outline" : "dm-btn--primary"}`} href={whatsappUrl} target="_blank" rel="noopener noreferrer">
          {copy.whatsapp}
        </a>
      )}
      {!leadsEnabled && !whatsappUrl && <p className="dm-small">{copy.noChannel}</p>}
    </div>
  );
}
