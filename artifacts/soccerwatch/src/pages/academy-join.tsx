import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, CircleAlert, Globe2, ShieldCheck, UserRound } from "lucide-react";
import {
  getGetPublicAcademyJoinQueryKey,
  useGetPublicAcademyJoin,
  useSubmitPublicAcademyRegistration,
} from "@workspace/api-client-react";
import type { AcademyJoinRegistrationInput } from "@workspace/api-client-react";
import { useTranslation } from "@/i18n";

export default function AcademyJoinPage() {
  const { code = "" } = useParams<{ code: string }>();
  const { t, locale, setLocale } = useTranslation();
  const copy = t.academyJoin;
  const qc = useQueryClient();
  const academyQuery = useGetPublicAcademyJoin(code, {
    query: { queryKey: getGetPublicAcademyJoinQueryKey(code), enabled: Boolean(code) },
  });
  const submit = useSubmitPublicAcademyRegistration();
  const [form, setForm] = useState({
    playerName: "", dateOfBirth: "", guardianName: "", guardianPhone: "",
    preferredSquadId: "", notes: "", website: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<"success" | "duplicate" | "error" | null>(null);
  useEffect(() => {
    const requestedLocale = new URLSearchParams(window.location.search).get("lang");
    setLocale(requestedLocale === "en" ? "en" : "ar");
  }, [code, setLocale]);
  const toggleLocale = () => {
    const nextLocale = locale === "ar" ? "en" : "ar";
    setLocale(nextLocale);
    const url = new URL(window.location.href);
    url.searchParams.set("lang", nextLocale);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };

  const update = (key: keyof typeof form, value: string) => {
    setForm((old) => ({ ...old, [key]: value }));
    setErrors((old) => ({ ...old, [key]: "" }));
    setResult(null);
  };
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!form.playerName.trim()) next.playerName = copy.required;
    if (!/^[0-9+ ()-]{7,20}$/.test(form.guardianPhone.trim())) next.guardianPhone = copy.phoneInvalid;
    if (form.playerName.trim().length > 120) next.playerName = copy.nameTooLong;
    if (form.guardianName.length > 120) next.guardianName = copy.guardianTooLong;
    if (form.notes.length > 500) next.notes = copy.notesTooLong;
    setErrors(next);
    if (Object.keys(next).length) return;
    try {
      const data: AcademyJoinRegistrationInput = {
        playerName: form.playerName.trim(),
        dateOfBirth: form.dateOfBirth || null,
        guardianName: form.guardianName.trim() || null,
        guardianPhone: form.guardianPhone.trim(),
        preferredSquadId: form.preferredSquadId ? Number(form.preferredSquadId) : null,
        notes: form.notes.trim() || null,
        locale,
        website: form.website,
      };
      const response = await submit.mutateAsync({ code, data });
      setResult(response.duplicate ? "duplicate" : "success");
      await qc.invalidateQueries({ queryKey: getGetPublicAcademyJoinQueryKey(code) });
    } catch {
      setResult("error");
    }
  };

  const academy = academyQuery.data;
  return (
    <main className="join-page min-h-[100dvh]" dir={locale === "ar" ? "rtl" : "ltr"}>
      <header className="join-header">
        <div className="join-brand"><span className="join-mark">S</span><span>SOCCERWATCH</span><span className="join-brand-divider" />{copy.registration}</div>
        <button type="button" onClick={toggleLocale} className="join-locale" aria-label={copy.changeLanguage} data-testid="button-join-language">
          <Globe2 size={16} /> {locale === "ar" ? "EN" : "عربي"}
        </button>
      </header>
      <div className="join-layout">
        <section className="join-story">
          <div className="join-pitch-mark" aria-hidden="true"><span /><span /><span /></div>
          <p className="join-kicker">{copy.footballStartsHere}</p>
          <h1>{copy.heroTitle}<em>{copy.heroEmphasis}</em></h1>
          <p className="join-story-copy">{copy.heroDescription}</p>
          <div className="join-trust"><ShieldCheck size={17} /><span>{copy.privateDetails}</span></div>
          <div className="join-side-note"><span className="join-note-line" /><span>{copy.oneSimpleStep}</span></div>
        </section>

        <section className="join-form-wrap">
          {academyQuery.isLoading ? (
            <div className="join-card join-skeleton" aria-label={copy.loading}><div /><div /><div /><div /></div>
          ) : academyQuery.isError || !academy ? (
            <div className="join-card join-error" role="alert">
              <CircleAlert size={25} /><h2>{copy.linkUnavailable}</h2><p>{copy.linkUnavailableDescription}</p>
              <button type="button" onClick={() => void academyQuery.refetch()} className="join-submit">{copy.retry}</button>
            </div>
          ) : result === "success" || result === "duplicate" ? (
            <div className="join-card join-success" role="status" data-testid="join-submission-success">
              <div className="join-success-icon"><Check size={27} /></div>
              <p className="join-form-kicker">{academy.academyName}</p>
              <h2>{result === "duplicate" ? copy.duplicateTitle : copy.successTitle}</h2>
              <p>{result === "duplicate" ? copy.duplicateDescription : copy.successDescription}</p>
              <div className="join-next-step"><span className="join-step-number">01</span><span>{copy.successNext}</span><ArrowUpRight size={16} /></div>
            </div>
          ) : (
            <div className="join-card">
              <div className="join-academy">
                <span className="join-academy-logo">
                  {academy.logoUrl ? <img src={academy.logoUrl} alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : null}
                  <UserRound size={19} />
                </span>
                <span><small>{copy.applyTo}</small><strong dir="auto">{academy.academyName}</strong></span>
              </div>
              <div className="join-form-heading">
                <p className="join-form-kicker">{copy.registration}</p>
                <h2>{copy.formTitle}</h2>
                <p>{copy.formDescription}</p>
              </div>
              <form onSubmit={(event) => void onSubmit(event)} noValidate className="join-form">
                <div className="join-field">
                  <label htmlFor="join-player">{copy.playerName}<b aria-hidden="true">*</b></label>
                  <input id="join-player" value={form.playerName} onChange={(e) => update("playerName", e.target.value)} maxLength={120} autoComplete="name" required aria-invalid={Boolean(errors.playerName)} aria-describedby={errors.playerName ? "join-player-error" : undefined} data-testid="input-join-player-name" />
                  {errors.playerName && <span id="join-player-error" className="join-field-error" role="alert">{errors.playerName}</span>}
                </div>
                <div className="join-field-grid">
                  <div className="join-field">
                    <label htmlFor="join-dob">{copy.dateOfBirth}</label>
                    <input id="join-dob" type="date" value={form.dateOfBirth} onChange={(e) => update("dateOfBirth", e.target.value)} data-testid="input-join-date-of-birth" />
                  </div>
                  <div className="join-field">
                    <label htmlFor="join-squad">{copy.preferredSquad}</label>
                    <select id="join-squad" value={form.preferredSquadId} onChange={(e) => update("preferredSquadId", e.target.value)} data-testid="select-join-squad">
                      <option value="">{copy.noPreference}</option>
                      {academy.squads.map((squad) => <option key={squad.id} value={squad.id}>{squad.name}{squad.ageGroup ? ` · ${squad.ageGroup}` : ""}</option>)}
                    </select>
                  </div>
                </div>
                <div className="join-field-grid">
                  <div className="join-field">
                    <label htmlFor="join-guardian">{copy.guardianName}</label>
                    <input id="join-guardian" value={form.guardianName} onChange={(e) => update("guardianName", e.target.value)} maxLength={120} autoComplete="name" data-testid="input-join-guardian-name" />
                    {errors.guardianName && <span className="join-field-error" role="alert">{errors.guardianName}</span>}
                  </div>
                  <div className="join-field">
                    <label htmlFor="join-phone">{copy.guardianPhone}<b aria-hidden="true">*</b></label>
                    <input id="join-phone" type="tel" inputMode="tel" value={form.guardianPhone} onChange={(e) => update("guardianPhone", e.target.value)} maxLength={20} autoComplete="tel" required aria-invalid={Boolean(errors.guardianPhone)} aria-describedby={errors.guardianPhone ? "join-phone-error" : undefined} data-testid="input-join-guardian-phone" />
                    {errors.guardianPhone && <span id="join-phone-error" className="join-field-error" role="alert">{errors.guardianPhone}</span>}
                  </div>
                </div>
                <div className="join-field">
                  <label htmlFor="join-notes">{copy.notes}<span>{copy.optional}</span></label>
                  <textarea id="join-notes" rows={3} maxLength={500} value={form.notes} onChange={(e) => update("notes", e.target.value)} data-testid="input-join-notes" />
                  {errors.notes && <span className="join-field-error" role="alert">{errors.notes}</span>}
                </div>
                <div className="join-honeypot" aria-hidden="true"><label htmlFor="join-website">Website</label><input id="join-website" tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => update("website", e.target.value)} /></div>
                {result === "error" && <p className="join-submit-error" role="alert">{copy.submitError}</p>}
                <button type="submit" disabled={submit.isPending} className="join-submit" data-testid="button-submit-registration">
                  {submit.isPending ? copy.submitting : copy.submit}
                  <ArrowUpRight size={17} aria-hidden="true" />
                </button>
                <p className="join-privacy"><ShieldCheck size={14} />{copy.privacyNote}</p>
              </form>
            </div>
          )}
          <p className="join-footer">SOCCERWATCH <span>·</span> {copy.footer}</p>
        </section>
      </div>
    </main>
  );
}