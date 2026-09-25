/**
 * "Find yourself" — the gallery claim flow.
 *
 * The chain at /claim/:id asks about every track break: roughly 150 questions
 * per player per game. This asks four things instead — what you wore, which
 * one is you, what isn't you, and a handful of joins — and a whole game was
 * measured at 6 minutes 55 seconds and 141 taps, finding 1:20:54 of 1:21:14 in
 * play. The chain is not deleted: it is the fallback for "I can't see myself",
 * it fills the gaps, and it is where the training labels come from.
 *
 * THIS FILE COVERS SCREENS 2 TO 6: intro, kit, gallery, the taken/exit states
 * and the name dialog. Correct-and-expand (strike out, also-me, joins, gaps,
 * when you were playing) and the result screens are not here yet; the "Next"
 * at the end of the gallery hands over to the chain, which is a worse but
 * complete path, rather than to a dead end.
 *
 * Nothing here shows a timer or a tap counter. Measuring a player's effort
 * back at them is the app grading itself.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetClaimChainQueryKey,
  getGetClaimMatchQueryKey,
  useGetClaimChain,
  useGetClaimMatch,
} from "@workspace/api-client-react";

import { useAuth } from "@/lib/auth";
import { useClaimCopy } from "@/i18n/claim-strings";
import {
  type ClaimPerson,
  type SpriteStrips,
  buildGallery,
  displaySecondsForFrame,
  formatClock,
  galleryCrops,
  mergeSprites,
} from "@/lib/claim-gallery";
import {
  type KitSplit,
  type TorsoColour,
  combineColours,
  isDarkKit,
  kitColourKey,
  splitKits,
  torsoColourFromJpeg,
} from "@/lib/claim-kit";
import {
  Chip,
  ClaimScreen,
  CropPlaceholder,
  CropTile,
  Eyebrow,
  Lead,
  Num,
  PrimaryAction,
  QuietAction,
  RowAction,
  ScreenTitle,
  SecondaryAction,
  StateBlock,
  StepHeader,
  TextLink,
} from "@/components/claim/primitives";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Measured on a whole game with the prototype: 6:55. Rounded, not inflated. */
const TYPICAL_MINUTES = 7;
/** Enough crops to read a kit colour without decoding the whole strip. */
const KIT_SAMPLE_CROPS = 3;

type Step = "intro" | "kit" | "gallery";

type SpriteState =
  | { status: "loading" }
  | { status: "ready"; sprites: SpriteStrips; segmentsWithCrops: number }
  | { status: "failed" };

export default function ClaimFindPage() {
  const params = useParams<{ id?: string }>();
  const [, setLocation] = useLocation();
  const { user, isLoading: authLoading, isGuest } = useAuth();
  const copy = useClaimCopy();
  const queryClient = useQueryClient();

  const recordingId = Number(params.id);
  const enabled = Number.isInteger(recordingId) && recordingId > 0 && Boolean(user) && !isGuest;

  const matchQueryKey = useMemo(() => getGetClaimMatchQueryKey(recordingId), [recordingId]);
  const chainQueryKey = useMemo(() => getGetClaimChainQueryKey(recordingId), [recordingId]);
  const claimQuery = useGetClaimMatch(recordingId, { query: { enabled, queryKey: matchQueryKey } });
  const chainQuery = useGetClaimChain(recordingId, { query: { enabled, queryKey: chainQueryKey } });

  const manifest = claimQuery.data?.manifest;
  const chain = chainQuery.data ?? null;

  const [step, setStep] = useState<Step>("intro");
  const [kitKey, setKitKey] = useState<string | null>(null);
  /* Back from the gallery returns to the kit step only if that step was shown. */
  const [kitShown, setKitShown] = useState(false);
  const [pending, setPending] = useState<ClaimPerson | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /* ------------------------------------------------------------------ crops */

  const [spriteState, setSpriteState] = useState<SpriteState>({ status: "loading" });

  useEffect(() => {
    if (!manifest || !enabled) return;
    let cancelled = false;
    setSpriteState({ status: "loading" });
    (async () => {
      const perSegment = await Promise.all(
        manifest.segments.map(async (segment) => {
          try {
            const response = await fetch(
              `${basePath}/api/recordings/${recordingId}/claim-match/sprites/${segment.index}`,
              { credentials: "include" },
            );
            if (!response.ok) return null;
            return await response.json() as SpriteStrips;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const present = perSegment.filter((entry): entry is SpriteStrips => entry !== null);
      // A bundle with no sprites at all is not a failure to retry — it is a
      // bundle that never carried crops, and no amount of reloading will
      // produce them. The gallery cannot run without pictures, so this is the
      // branch that sends the claimant to the chain instead.
      setSpriteState(
        present.length === 0
          ? { status: "failed" }
          : { status: "ready", sprites: mergeSprites(present), segmentsWithCrops: present.length },
      );
    })();
    return () => { cancelled = true; };
  }, [manifest, recordingId, enabled]);

  const sprites = spriteState.status === "ready" ? spriteState.sprites : null;

  /* --------------------------------------------------------------- people */

  const gallery = useMemo(
    () => (manifest ? buildGallery(manifest, sprites ?? {}) : null),
    [manifest, sprites],
  );

  const cropsFor = useCallback(
    (person: ClaimPerson, count = 6) => (sprites ? galleryCrops(person, sprites, count) : []),
    [sprites],
  );

  /* ------------------------------------------------------------------ kits */

  const [kitSplit, setKitSplit] = useState<KitSplit | null>(null);

  useEffect(() => {
    if (!gallery || !sprites || gallery.people.length === 0) {
      setKitSplit(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const readings: Array<{ id: string; colour: TorsoColour | null }> = [];
      for (const person of gallery.people) {
        const samples = galleryCrops(person, sprites, KIT_SAMPLE_CROPS);
        const colours = await Promise.all(samples.map((crop) => torsoColourFromJpeg(crop.jpeg)));
        if (cancelled) return;
        readings.push({ id: person.id, colour: combineColours(colours) });
      }
      if (!cancelled) setKitSplit(splitKits(readings));
    })();
    return () => { cancelled = true; };
  }, [gallery, sprites]);

  const peopleInKit = useMemo(() => {
    if (!gallery) return [];
    if (!kitKey || !kitSplit) return gallery.people;
    const group = kitSplit.groups.find((candidate) => candidate.key === kitKey);
    if (!group) return gallery.people;
    const members = new Set(group.memberIds);
    return gallery.people.filter((person) => members.has(person.id));
  }, [gallery, kitKey, kitSplit]);

  const kitLabel = useMemo(() => {
    if (!kitKey || !kitSplit) return null;
    const group = kitSplit.groups.find((candidate) => candidate.key === kitKey);
    return group ? kitName(copy, group.swatch) : null;
  }, [copy, kitKey, kitSplit]);

  /* ------------------------------------------------------------- the pick */

  const claimPerson = useCallback(
    async (person: ClaimPerson, name: string | null) => {
      setSaving(true);
      setSaveError(null);
      const part = person.parts[0];
      try {
        const response = await fetch(
          `${basePath}/api/recordings/${recordingId}/claim-match/chain/tap`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              trackId: part.trackId,
              frame: part.fromFrame,
              bundleFingerprint: chain?.bundleFingerprint ?? null,
              ...(name ? { name } : {}),
            }),
          },
        );
        // 409 is the old dispute path: another player vouched for frames that
        // overlap this pick. An overlap now CONFIRMS both claimants, so this
        // is not an error to show — the pick stands and both keep their
        // stretch. The server still returns it; removing it there is the other
        // half of this change and has not been made yet.
        if (!response.ok && response.status !== 409) {
          throw new Error(String(response.status));
        }
        await queryClient.invalidateQueries({ queryKey: chainQueryKey });
        await queryClient.invalidateQueries({ queryKey: matchQueryKey });
        setPending(null);
        setLocation(`/claim/${recordingId}`);
      } catch {
        setSaveError(copy.common.saveFailedDesc);
      } finally {
        setSaving(false);
      }
    },
    [chain?.bundleFingerprint, chainQueryKey, copy.common.saveFailedDesc, matchQueryKey, queryClient, recordingId, setLocation],
  );

  /* ---------------------------------------------------------------- gates */

  if (!authLoading && (!user || isGuest)) {
    return (
      <ClaimScreen>
        <StateBlock
          title={copy.common.signedOut}
          body={copy.common.signedOutDesc}
          action={<PrimaryAction onClick={() => setLocation("/sign-in")}>{copy.common.signIn}</PrimaryAction>}
        />
      </ClaimScreen>
    );
  }

  if (authLoading || claimQuery.isLoading) {
    return (
      <ClaimScreen>
        <StateBlock tone="busy" title={copy.gallery.loading} />
      </ClaimScreen>
    );
  }

  if (claimQuery.isError || !manifest || !gallery) {
    return (
      <ClaimScreen>
        <StateBlock
          tone="failed"
          title={copy.entry.notReady}
          body={copy.entry.notReadyDesc}
          action={<SecondaryAction onClick={() => setLocation("/fields")}>{copy.common.back}</SecondaryAction>}
        />
      </ClaimScreen>
    );
  }

  const recording = claimQuery.data?.recording ?? null;
  const fieldHref = recording?.fieldId ? `/fields/${recording.fieldId}` : "/fields";
  const coveragePercent = chain?.coveragePercent ?? 0;
  const alreadyStarted = Boolean(chain?.chain?.length);
  const openKitOrGallery = () => {
    if (kitSplit?.separated) {
      setKitShown(true);
      setStep("kit");
    } else {
      setStep("gallery");
    }
  };

  /* ---------------------------------------------------------------- views */

  if (step === "intro") {
    return (
      <IntroScreen
        copy={copy}
        eyebrow={recording ? matchEyebrow(recording, copy.locale) : copy.intro.eyebrow}
        alreadyStarted={alreadyStarted}
        coveragePercent={coveragePercent}
        completed={Boolean(chain?.completed)}
        resetByAdmin={Boolean(chain?.resetByAdmin) && !alreadyStarted}
        onStart={openKitOrGallery}
        onClose={() => setLocation(fieldHref)}
        onSeeStats={() => setLocation(`/claim/${recordingId}`)}
      />
    );
  }

  if (spriteState.status === "loading") {
    return (
      <ClaimScreen>
        <StateBlock tone="busy" title={copy.gallery.loading} />
      </ClaimScreen>
    );
  }

  if (spriteState.status === "failed" || gallery.people.length === 0) {
    return (
      <ClaimScreen>
        <StepHeader
          label={copy.gallery.eyebrow}
          step={2}
          of={4}
          savedLabel={copy.common.saved}
          backLabel={copy.common.back}
          onBack={() => setStep("intro")}
        />
        <StateBlock
          tone="failed"
          title={copy.gallery.failed}
          body={copy.gallery.failedDesc}
          action={
            <SecondaryAction onClick={() => setLocation(`/claim/${recordingId}`)}>
              {copy.gallery.findInVideoShort}
            </SecondaryAction>
          }
        />
      </ClaimScreen>
    );
  }

  if (step === "kit") {
    return (
      <KitScreen
        copy={copy}
        split={kitSplit}
        people={gallery.people}
        cropsFor={cropsFor}
        initialKey={kitKey}
        onBack={() => setStep("intro")}
        onPick={(key) => { setKitKey(key); setStep("gallery"); }}
        onSkip={() => { setKitKey(null); setStep("gallery"); }}
        onChain={() => setLocation(`/claim/${recordingId}`)}
      />
    );
  }

  return (
    <>
      <GalleryScreen
        copy={copy}
        people={peopleInKit}
        kitLabel={kitLabel}
        ungrouped={gallery.source === "tracks"}
        frameRate={gallery.frameRate}
        matchOffset={manifest.matchOffset}
        yourIdentityId={chain?.identityId ?? null}
        cropsFor={cropsFor}
        canChangeKit={Boolean(kitSplit?.separated)}
        onBack={() => setStep(kitShown ? "kit" : "intro")}
        onChangeKit={() => { setKitShown(true); setStep("kit"); }}
        onPick={(person) => { setSaveError(null); setPending(person); }}
        onChain={() => setLocation(`/claim/${recordingId}`)}
        onNotInMatch={() => setLocation(fieldHref)}
        saveError={saveError}
      />
      {pending && (
        <NameDialog
          copy={copy}
          defaultName={chain?.name ?? user?.name ?? ""}
          accountName={user?.name ?? ""}
          crops={cropsFor(pending, 3)}
          saving={saving}
          onCancel={() => { setPending(null); setSaveError(null); }}
          onConfirm={(name) => claimPerson(pending, name)}
        />
      )}
    </>
  );
}

type ClaimCopy = ReturnType<typeof useClaimCopy>;
type CropsFor = (person: ClaimPerson, count?: number) => Array<{ jpeg: string; frame: number }>;

/** "Thursday 24 September · Pitch 2" -- the match this claim is about (CL02). */
export function matchEyebrow(
  recording: { date: string; court?: string | null },
  locale: "en" | "ar",
): string {
  const parsed = new Date(`${recording.date}T12:00:00`);
  const day = Number.isNaN(parsed.getTime())
    ? recording.date
    : parsed.toLocaleDateString(locale === "ar" ? "ar-u-nu-latn" : "en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  return recording.court ? `${day} · ${recording.court}` : day;
}

/** The kit's plain colour name, e.g. "Royal blue". */
export function kitName(copy: ClaimCopy, swatch: string): string {
  return copy.kit.names[kitColourKey(swatch)] ?? copy.kit.names.dark;
}

/*
 * The screens are exported as well as used here so they can be rendered on
 * their own -- at 390px, in both languages, against stub data -- without a
 * signed-in session and a tracking bundle behind them. Every branch below is
 * reachable that way, which is the only practical way to check the empty,
 * taken and failed states.
 */

/* ====================================================================== 2 */

export function IntroScreen({
  copy,
  eyebrow,
  alreadyStarted,
  coveragePercent,
  completed,
  resetByAdmin,
  onStart,
  onClose,
  onSeeStats,
}: {
  copy: ClaimCopy;
  eyebrow: string;
  alreadyStarted: boolean;
  coveragePercent: number;
  completed: boolean;
  resetByAdmin: boolean;
  onStart: () => void;
  onClose: () => void;
  onSeeStats: () => void;
}) {
  const steps = [
    { title: copy.intro.step1Title, body: copy.intro.step1Body },
    { title: copy.intro.step2Title, body: copy.intro.step2Body },
    { title: copy.intro.step3Title, body: copy.intro.step3Body },
    { title: copy.intro.step4Title, body: copy.intro.step4Body },
  ];
  return (
    <ClaimScreen>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onClose}
          aria-label={copy.intro.close}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-line text-text hover:border-muted-text"
        >
          <span aria-hidden="true" className="text-base leading-none">&#215;</span>
        </button>
      </div>

      <div className="mt-6">
        <Eyebrow>{eyebrow}</Eyebrow>
        <ScreenTitle>{copy.intro.title}</ScreenTitle>
        <Lead>{copy.intro.lead(TYPICAL_MINUTES)}</Lead>
      </div>

      {resetByAdmin && (
        <div className="mt-4 rounded-2xl border border-line bg-surface p-4">
          <p className="font-display text-base font-bold text-text">{copy.intro.resetTitle}</p>
          <p className="mt-1 text-sm leading-6 text-muted-text">{copy.intro.resetBody}</p>
        </div>
      )}

      {alreadyStarted && (
        <div className="mt-4 rounded-2xl border border-turf/40 bg-turf/10 p-4">
          <p className="text-sm font-semibold text-turf">
            {copy.intro.resumeDesc(Math.round(coveragePercent))}
          </p>
        </div>
      )}

      <ol className="mt-5 space-y-2.5">
        {steps.map((entry, index) => (
          <li key={entry.title} className="flex items-center gap-3.5 rounded-2xl border border-line bg-surface p-3.5">
            <Num className="w-5 shrink-0 text-lg font-bold text-turf">{index + 1}</Num>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text">{entry.title}</p>
              <p className="mt-0.5 text-xs leading-5 text-muted-text">{entry.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-5">
        <PrimaryAction onClick={onStart}>
          {alreadyStarted ? copy.intro.resume : copy.intro.start}
        </PrimaryAction>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted-text">{copy.intro.savedAsYouGo}</p>
      {completed && (
        <div className="mt-2">
          <TextLink onClick={onSeeStats}>{copy.intro.seeStats}</TextLink>
        </div>
      )}
    </ClaimScreen>
  );
}

/* ====================================================================== 3 */

export function KitScreen({
  copy,
  split,
  people,
  cropsFor,
  initialKey = null,
  onBack,
  onPick,
  onSkip,
  onChain,
}: {
  copy: ClaimCopy;
  split: KitSplit | null;
  people: ClaimPerson[];
  cropsFor: CropsFor;
  initialKey?: string | null;
  onBack: () => void;
  onPick: (key: string) => void;
  onSkip: () => void;
  onChain: () => void;
}) {
  const byId = useMemo(() => new Map(people.map((person) => [person.id, person])), [people]);
  const [selected, setSelected] = useState<string | null>(initialKey);

  const header = (
    <StepHeader
      label={copy.kit.eyebrow}
      step={1}
      of={4}
      savedLabel={copy.common.saved}
      backLabel={copy.common.back}
      onBack={onBack}
    />
  );

  if (!split) {
    return (
      <ClaimScreen>
        {header}
        <StateBlock tone="busy" title={copy.gallery.loading} />
      </ClaimScreen>
    );
  }

  if (!split.separated) {
    return (
      <ClaimScreen>
        {header}
        <ScreenTitle>{copy.kit.title}</ScreenTitle>
        <div className="mt-4">
          <StateBlock title={copy.kit.none} body={copy.kit.noneDesc} />
        </div>
        <div className="mt-5 space-y-1">
          <PrimaryAction onClick={onSkip}>{copy.kit.notSure}</PrimaryAction>
          <QuietAction onClick={onChain}>{copy.kit.findInVideo}</QuietAction>
        </div>
      </ClaimScreen>
    );
  }

  const selectedGroup = split.groups.find((group) => group.key === selected) ?? null;
  const showDarkNote = split.groups.some((group) => isDarkKit(group.swatch));

  return (
    <ClaimScreen>
      {header}
      <ScreenTitle>{copy.kit.title}</ScreenTitle>
      <Lead>{copy.kit.lead}</Lead>

      <div className="mt-4 grid grid-cols-2 gap-3">
        {split.groups.map((group) => {
          const members = group.memberIds
            .map((id) => byId.get(id))
            .filter((person): person is ClaimPerson => Boolean(person));
          const taken = members.filter((person) => person.name !== null).length;
          const samples = members
            .slice(0, 3)
            .map((person) => ({ person, crop: cropsFor(person, 1)[0] ?? null }));
          const isSelected = group.key === selected;
          return (
            <button
              key={group.key}
              type="button"
              aria-pressed={isSelected}
              onClick={() => setSelected(group.key)}
              className={`flex flex-col gap-2.5 rounded-2xl border bg-surface p-2.5 text-start transition-colors ${
                isSelected ? "border-turf" : "border-line hover:border-muted-text"
              }`}
            >
              <span className="grid grid-cols-3 gap-1.5">
                {Array.from({ length: 3 }, (_, index) => {
                  const sample = samples[index];
                  return (
                    <span key={index} className="block">
                      {sample?.crop
                        ? <CropTile jpeg={sample.crop.jpeg} alt="" />
                        : <CropPlaceholder label="" />}
                    </span>
                  );
                })}
              </span>
              <span className="flex items-center gap-2 px-0.5">
                <span
                  aria-hidden="true"
                  className="h-3 w-3 shrink-0 rounded-full border border-line"
                  style={{ backgroundColor: group.swatch }}
                />
                <span className="min-w-0 truncate text-sm font-semibold text-text">{kitName(copy, group.swatch)}</span>
              </span>
              <span className="flex flex-wrap items-baseline gap-x-1.5 px-0.5 text-[11px] text-muted-text">
                <Num className="text-sm font-bold text-turf">{members.length - taken}</Num>
                <span>{copy.kit.unclaimedWord}</span>
                <Num className="text-sm font-bold text-muted-text">{taken}</Num>
                <span>{copy.kit.foundWord}</span>
              </span>
            </button>
          );
        })}
      </div>

      {showDarkNote && (
        <div className="mt-4 flex gap-2.5 rounded-2xl border border-line bg-surface p-3.5">
          <span aria-hidden="true" className="text-sm leading-5 text-[#A98CFF]">&#9432;</span>
          <p className="text-xs leading-5 text-muted-text">{copy.kit.darkNote}</p>
        </div>
      )}

      <div className="mt-5">
        <PrimaryAction
          disabled={!selectedGroup}
          onClick={() => { if (selectedGroup) onPick(selectedGroup.key); }}
        >
          {selectedGroup ? copy.kit.show(kitName(copy, selectedGroup.swatch)) : copy.kit.pickFirst}
        </PrimaryAction>
      </div>
      <div className="mt-1">
        <TextLink onClick={onSkip}>{copy.kit.changedKit}</TextLink>
      </div>
    </ClaimScreen>
  );
}

/* ==================================================================== 4/5 */

export function GalleryScreen({
  copy,
  people,
  kitLabel = null,
  ungrouped,
  frameRate,
  matchOffset,
  yourIdentityId,
  cropsFor,
  canChangeKit,
  onBack,
  onChangeKit,
  onPick,
  onChain,
  onNotInMatch,
  saveError,
  initialShowHelp = false,
}: {
  copy: ClaimCopy;
  people: ClaimPerson[];
  kitLabel?: string | null;
  ungrouped: boolean;
  frameRate: number;
  matchOffset: number;
  yourIdentityId: string | null;
  cropsFor: CropsFor;
  canChangeKit: boolean;
  onBack: () => void;
  onChangeKit: () => void;
  onPick: (person: ClaimPerson) => void;
  onChain: () => void;
  onNotInMatch: () => void;
  saveError: string | null;
  initialShowHelp?: boolean;
}) {
  const clock = { frameRate, matchOffset };
  const [showHelp, setShowHelp] = useState(initialShowHelp);
  const helpRef = useRef<HTMLDivElement | null>(null);

  const yours = people.filter((person) => person.id === yourIdentityId);
  const available = people.filter((person) => person.name === null && person.id !== yourIdentityId);
  const claimed = people.filter((person) => person.name !== null && person.id !== yourIdentityId);
  const helpOpen = showHelp || available.length === 0;

  useEffect(() => {
    if (showHelp) helpRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [showHelp]);

  const row = (person: ClaimPerson, kind: "open" | "yours" | "claimed") => {
    const crops = cropsFor(person, 6);
    const struck = kind === "claimed";
    return (
      <li
        key={person.id}
        className={`rounded-2xl border bg-surface p-3 ${kind === "yours" ? "border-turf" : "border-line"} ${struck ? "opacity-55" : ""}`}
      >
        <div className="grid grid-cols-6 gap-1.5">
          {Array.from({ length: 6 }, (_, index) => {
            const crop = crops[index];
            return crop
              ? <CropTile key={index} jpeg={crop.jpeg} alt="" struck={struck} />
              : <CropPlaceholder key={index} label="" />;
          })}
        </div>
        <div className="mt-2.5 flex items-center gap-3">
          <div className="shrink-0">
            <Num className={`block text-lg font-bold leading-none ${struck ? "text-muted-text" : "text-text"}`}>
              {formatClock(person.onCameraSeconds)}
            </Num>
            <span className="mt-1 block text-[11px] leading-none text-muted-text">{copy.gallery.onCameraWord}</span>
          </div>
          <p className="min-w-0 flex-1 truncate text-xs text-muted-text">
            {copy.gallery.seenWord}{" "}
            {/* One LTR run: in RTL an en dash between two numbers would
                otherwise flip the range to "5:14–1:14". */}
            <Num>
              {formatClock(displaySecondsForFrame(person.firstFrame, clock))}–{formatClock(displaySecondsForFrame(person.lastFrame, clock))}
            </Num>
          </p>
          {kind === "open" && <RowAction onClick={() => onPick(person)}>{copy.gallery.thisIsMe}</RowAction>}
          {kind === "yours" && <Chip tone="turf">{copy.gallery.takenByYou}</Chip>}
          {kind === "claimed" && (
            <span className="shrink-0 rounded-full bg-raised px-2.5 py-1 font-display text-[11px] font-bold uppercase tracking-[0.08em] text-muted-text">
              {copy.gallery.takenBy(person.name ?? "")}
            </span>
          )}
        </div>
      </li>
    );
  };

  return (
    <ClaimScreen>
      <StepHeader
        label={copy.gallery.eyebrow}
        step={2}
        of={4}
        savedLabel={copy.common.saved}
        backLabel={copy.common.back}
        onBack={onBack}
      />
      <ScreenTitle>{copy.gallery.title}</ScreenTitle>
      <Lead>{copy.gallery.lead}</Lead>
      {kitLabel && (
        <p className="mt-3 font-display text-base font-bold text-text">
          {copy.gallery.kitHeading(kitLabel, people.length)}
        </p>
      )}

      {ungrouped && (
        <p className="mt-4 rounded-2xl border border-violet/40 bg-violet/10 p-3 text-xs leading-5 text-[#A98CFF]">
          {copy.gallery.ungrouped}
        </p>
      )}

      {saveError && (
        <div className="mt-4">
          <StateBlock tone="failed" title={copy.common.saveFailed} body={saveError} />
        </div>
      )}

      {(yours.length > 0 || available.length > 0) && (
        <ul className="mt-4 space-y-3">
          {yours.map((person) => row(person, "yours"))}
          {available.map((person) => row(person, "open"))}
        </ul>
      )}

      {available.length === 0 && (
        <div className="mt-4">
          <StateBlock title={copy.gallery.none} body={copy.gallery.noneDesc} />
        </div>
      )}

      {!helpOpen && (
        <div className="mt-2">
          <TextLink onClick={() => setShowHelp(true)}>{copy.gallery.noneOfThese}</TextLink>
        </div>
      )}

      {claimed.length > 0 && (
        <>
          <div className="mt-5">
            <Eyebrow>{copy.gallery.alreadyClaimed(claimed.length)}</Eyebrow>
          </div>
          <ul className="mt-2.5 space-y-3">
            {claimed.map((person) => row(person, "claimed"))}
          </ul>
        </>
      )}

      {helpOpen && (
        <div ref={helpRef} className="mt-5 scroll-mt-4">
          <div className="rounded-2xl border border-line bg-surface p-4">
            <p className="font-display text-base font-bold text-text">{copy.gallery.stillCantSee}</p>
            <p className="mt-1.5 text-sm leading-6 text-muted-text">{copy.gallery.stillCantSeeBody}</p>
            <div className="mt-4 flex gap-2">
              {canChangeKit && (
                <SecondaryAction onClick={onChangeKit} className="w-auto flex-1 px-3">
                  {copy.gallery.changeKitShort}
                </SecondaryAction>
              )}
              <button
                type="button"
                onClick={onChain}
                className="flex min-h-12 flex-1 items-center justify-center rounded-full border border-line px-3 py-2 text-center text-sm font-semibold leading-snug text-text transition-colors hover:border-muted-text"
              >
                {copy.gallery.findInVideoShort}
              </button>
            </div>
          </div>
          <div className="mt-2">
            <TextLink onClick={onNotInMatch}>{copy.gallery.notInMatch}</TextLink>
          </div>
        </div>
      )}
    </ClaimScreen>
  );
}

/* ====================================================================== 6 */

/**
 * The name dialog, on the first pick only.
 *
 * It MUST have a way out. The current one in the chain has none: it opens on
 * the first tap and the only control commits, so a mistaken tap becomes a
 * claim. Here the close button, the backdrop and Escape all return to the
 * gallery having written nothing.
 */
export function NameDialog({
  copy,
  defaultName,
  accountName = "",
  crops = [],
  saving,
  onCancel,
  onConfirm,
}: {
  copy: ClaimCopy;
  defaultName: string;
  accountName?: string;
  crops?: Array<{ jpeg: string; frame: number }>;
  saving: boolean;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const submit = (value = name) => {
    const trimmed = value.trim();
    if (!trimmed) { setError(copy.name.empty); return; }
    if (trimmed.length > 40) { setError(copy.name.tooLong); return; }
    onConfirm(trimmed);
  };

  const account = accountName.trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-void/80 px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-10"
      onClick={(event) => { if (event.target === event.currentTarget && !saving) onCancel(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={copy.name.title}
        className="relative w-full max-w-[408px] rounded-2xl border border-line bg-surface p-5"
      >
        <button
          type="button"
          onClick={onCancel}
          aria-label={copy.name.cancel}
          className="absolute end-3 top-3 flex h-9 w-9 items-center justify-center rounded-full border border-line text-text hover:border-muted-text"
        >
          <span aria-hidden="true" className="text-base leading-none">&#215;</span>
        </button>
        {crops.length > 0 && (
          <div className="mb-3 flex gap-1.5">
            {crops.slice(0, 3).map((crop) => (
              <span key={crop.frame} className="block w-10">
                <CropTile jpeg={crop.jpeg} alt="" />
              </span>
            ))}
          </div>
        )}
        <p className="pe-10 font-display text-lg font-bold text-text">{copy.name.title}</p>
        <p className="mt-1.5 text-sm leading-6 text-muted-text">{copy.name.lead}</p>
        <label htmlFor="claim-name" className="mt-4 block font-display text-xs font-bold uppercase tracking-[0.12em] text-muted-text">
          {copy.name.label}
        </label>
        <input
          id="claim-name"
          ref={inputRef}
          value={name}
          onChange={(event) => { setName(event.target.value); setError(null); }}
          onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
          placeholder={copy.name.placeholder}
          maxLength={60}
          className="mt-1.5 h-12 w-full rounded-xl border border-line bg-raised px-4 text-base text-text outline-none focus:border-turf"
        />
        {error && <p className="mt-2 text-xs text-text" role="alert">{error}</p>}
        <div className="mt-4">
          <PrimaryAction onClick={() => submit()} disabled={saving}>
            {saving ? copy.common.saving : copy.name.save}
          </PrimaryAction>
        </div>
        {account && (
          <div className="mt-1">
            <TextLink onClick={() => { setName(account); submit(account); }}>{copy.name.useAccount}</TextLink>
          </div>
        )}
      </div>
    </div>
  );
}
