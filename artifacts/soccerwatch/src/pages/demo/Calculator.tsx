import { useId, useState } from "react";

import type { DemoCopy, Persona } from "./copy";
import { formatNumber } from "./data";

function Field({ label, value, onChange, min, max, step, locale }: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  locale: "ar" | "en";
}) {
  const id = useId();
  const clamp = (n: number) => Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
  return (
    <div className="dm-field">
      <label htmlFor={id}>{label}</label>
      <div className="dm-field-row">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(clamp(Number(event.target.value)))}
          aria-label={label}
          dir="ltr"
        />
        <input
          id={id}
          className="dm-num-input"
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(clamp(Number(event.target.value)))}
          lang={locale === "ar" ? "en" : undefined}
        />
      </div>
    </div>
  );
}

export function Calculator({ persona, copy, jod, locale }: {
  persona: Persona;
  copy: DemoCopy["sections"]["numbers"];
  jod: string;
  locale: "ar" | "en";
}) {
  const [bookings, setBookings] = useState(20);
  const [extra, setExtra] = useState(3);
  const [share, setShare] = useState(40);
  const [price, setPrice] = useState(40);
  const [extraBookings, setExtraBookings] = useState(1);
  const [players, setPlayers] = useState(60);
  const [perPlayer, setPerPlayer] = useState(3);
  const [newPlayers, setNewPlayers] = useState(2);
  const [fee, setFee] = useState(35);
  const [showFormula, setShowFormula] = useState(false);

  const weeksPerMonth = 52 / 12;
  const parts: Array<[string, number]> = persona === "pitch"
    ? [
      [copy.fromFilmed, bookings * weeksPerMonth * (share / 100) * extra],
      [copy.fromBookings, extraBookings * weeksPerMonth * price],
    ]
    : [
      [copy.fromFees, players * perPlayer],
      [copy.fromNewPlayers, newPlayers * fee],
    ];
  const monthly = parts.reduce((sum, [, value]) => sum + value, 0);

  return (
    <div className="dm-calc">
      <div className="dm-calc-inputs">
        {persona === "pitch" ? (
          <>
            <Field label={copy.pitch.bookings} value={bookings} onChange={setBookings} min={0} max={150} step={1} locale={locale} />
            <Field label={copy.pitch.extra} value={extra} onChange={setExtra} min={0} max={20} step={0.5} locale={locale} />
            <Field label={copy.pitch.share} value={share} onChange={setShare} min={0} max={100} step={5} locale={locale} />
            <Field label={copy.pitch.price} value={price} onChange={setPrice} min={0} max={150} step={5} locale={locale} />
            <Field label={copy.pitch.extraBookings} value={extraBookings} onChange={setExtraBookings} min={0} max={30} step={1} locale={locale} />
          </>
        ) : (
          <>
            <Field label={copy.academy.players} value={players} onChange={setPlayers} min={0} max={400} step={5} locale={locale} />
            <Field label={copy.academy.extra} value={perPlayer} onChange={setPerPlayer} min={0} max={20} step={0.5} locale={locale} />
            <Field label={copy.academy.newPlayers} value={newPlayers} onChange={setNewPlayers} min={0} max={30} step={1} locale={locale} />
            <Field label={copy.academy.fee} value={fee} onChange={setFee} min={0} max={150} step={5} locale={locale} />
          </>
        )}
      </div>
      <div className="dm-calc-result" aria-live="polite">
        <span className="dm-small">{copy.result}</span>
        <strong className="dm-big-num">{formatNumber(Math.round(monthly), locale)} <small>{jod}</small></strong>
        <span className="dm-small">{copy.perYear(formatNumber(Math.round(monthly * 12), locale))}</span>
        <ul className="dm-calc-parts">
          {parts.map(([label, value], index) => (
            <li key={label} id={`demo-calc-line-${index}`}><span>{label}</span><b className="dm-num">{formatNumber(Math.round(value), locale)} {jod}</b></li>
          ))}
        </ul>
        <button type="button" className="dm-formula-toggle" aria-expanded={showFormula} onClick={() => setShowFormula((shown) => !shown)}>
          {showFormula ? (locale === "ar" ? "إخفاء المعادلة" : "Hide formula") : (locale === "ar" ? "كيف حسبناها؟" : "How is this calculated?")}
        </button>
        {showFormula && <span className="dm-formula">{persona === "pitch" ? copy.formulaPitch : copy.formulaAcademy}</span>}
      </div>
      <p className="dm-small">{copy.note}</p>
    </div>
  );
}
