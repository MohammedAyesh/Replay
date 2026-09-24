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
  formatDuration,
  galleryCrops,
  mergeSprites,
} from "@/lib/claim-gallery";
import {
  type KitSplit,
  type TorsoColour,
  combineColours,
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
  ProgressRail,
  QuietAction,
  RowAction,
  SavedNote,
  ScreenTitle,
  SecondaryAction,
  StateBlock,
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

  const coveragePercent = chain?.coveragePercent ?? 0;
  const alreadyStarted = Boolean(chain?.chain?.length);

  /* ---------------------------------------------------------------- views */

  if (step === "intro") {
    return (
      <IntroScreen
        copy={copy}
        alreadyStarted={alreadyStarted}
        coveragePercent={coveragePercent}
        onStart={() => setStep(kitSplit?.separated ? "kit" : "gallery")}
        onLeave={() => setLocation(`/fields`)}
        onChain={() => setLocation(`/claim/${recordingId}`)}
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
      <ClaimScreen
        footer={
          <SecondaryAction onClick={() => setLocation(`/claim/${recordingId}`)}>
            {copy.gallery.findInVideo}
          </SecondaryAction>
        }
      >
        <StateBlock
          tone="failed"
          title={copy.gallery.failed}
          body={copy.gallery.failedDesc}
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
        ungrouped={gallery.source === "tracks"}
        frameRate={gallery.frameRate}
        matchOffset={manifest.matchOffset}
        yourIdentityId={chain?.identityId ?? null}
        cropsFor={cropsFor}
        canChangeKit={Boolean(kitKey)}
        onChangeKit={() => setStep("kit")}
        onPick={(person) => { setSaveError(null); setPending(person); }}
        onChain={() => setLocation(`/claim/${recordingId}`)}
        saveError={saveError}
      />
      {pending && (
        <NameDialog
          copy={copy}
          defaultName={chain?.name ?? user?.name ?? ""}
          saving={saving}
          onCancel={() => { setPending(null); setSaveError(null); }}
          onConfirm={(name) => claimPerson(pending, name)}
        />
      )}
    </>
  );
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
  alreadyStarted,
  coveragePercent,
  onStart,
  onLeave,
  onChain,
}: {
  copy: ReturnType<typeof useClaimCopy>;
  alreadyStarted: boolean;
  coveragePercent: number;
  onStart: () => void;
  onLeave: () => void;
  onChain: () => void;
}) {
  const steps = [
    { title: copy.intro.step1Title, body: copy.intro.step1Body },
    { title: copy.intro.step2Title, body: copy.intro.step2Body },
    { title: copy.intro.step3Title, body: copy.intro.step3Body },
    { title: copy.intro.step4Title, body: copy.intro.step4Body },
  ];
  return (
    <ClaimScreen
      footer={
        <div className="space-y-2">
          <PrimaryAction onClick={onStart}>
            {alreadyStarted ? copy.intro.resume : copy.intro.start}
          </PrimaryAction>
          <QuietAction onClick={onLeave}>{copy.common.leaveForNow}</QuietAction>
        </div>
      }
    >
      <Eyebrow>{copy.intro.eyebrow}</Eyebrow>
      <ScreenTitle>{copy.intro.title}</ScreenTitle>
      <Lead>{copy.intro.lead}</Lead>

      {alreadyStarted && (
        <div className="mt-4 rounded-2xl border border-turf/40 bg-turf/10 p-4">
          <p className="text-sm font-semibold text-turf">
            {copy.intro.resumeDesc(Math.round(coveragePercent))}
          </p>
          <p className="mt-1 text-xs text-muted-text">{copy.intro.savedAsYouGo}</p>
        </div>
      )}

      <ol className="mt-5 space-y-3">
        {steps.map((entry, index) => (
          <li key={entry.title} className="flex gap-3 rounded-2xl border border-line bg-surface p-4">
            <Num className="mt-0.5 w-6 shrink-0 text-base font-bold text-turf">{index + 1}</Num>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text">{entry.title}</p>
              <p className="mt-0.5 text-xs leading-5 text-muted-text">{entry.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <p className="mt-4 text-sm text-muted-text">{copy.intro.timeCost(TYPICAL_MINUTES)}</p>
      {!alreadyStarted && <SavedNote>{copy.intro.savedAsYouGo}</SavedNote>}

      <div className="mt-5">
        <QuietAction onClick={onChain}>{copy.gallery.findInVideo}</QuietAction>
      </div>
    </ClaimScreen>
  );
}

/* ====================================================================== 3 */

export function KitScreen({
  copy,
  split,
  people,
  cropsFor,
  onPick,
  onSkip,
  onChain,
}: {
  copy: ReturnType<typeof useClaimCopy>;
  split: KitSplit | null;
  people: ClaimPerson[];
  cropsFor: (person: ClaimPerson, count?: number) => Array<{ jpeg: string; frame: number }>;
  onPick: (key: string) => void;
  onSkip: () => void;
  onChain: () => void;
}) {
  const byId = useMemo(() => new Map(people.map((person) => [person.id, person])), [people]);

  if (!split) {
    return (
      <ClaimScreen>
        <StateBlock tone="busy" title={copy.gallery.loading} />
      </ClaimScreen>
    );
  }

  if (!split.separated) {
    return (
      <ClaimScreen
        footer={
          <div className="space-y-2">
            <PrimaryAction onClick={onSkip}>{copy.kit.notSure}</PrimaryAction>
            <QuietAction onClick={onChain}>{copy.kit.findInVideo}</QuietAction>
          </div>
        }
      >
        <Eyebrow>{copy.kit.eyebrow}</Eyebrow>
        <ScreenTitle>{copy.kit.title}</ScreenTitle>
        <div className="mt-4">
          <StateBlock title={copy.kit.none} body={copy.kit.noneDesc} />
        </div>
      </ClaimScreen>
    );
  }

  return (
    <ClaimScreen
      footer={
        <div className="space-y-2">
          <QuietAction onClick={onSkip}>{copy.kit.notSure}</QuietAction>
          <QuietAction onClick={onChain}>{copy.kit.findInVideo}</QuietAction>
        </div>
      }
    >
      <Eyebrow>{copy.kit.eyebrow}</Eyebrow>
      <ScreenTitle>{copy.kit.title}</ScreenTitle>
      <Lead>{copy.kit.lead}</Lead>
      <ProgressRail step={1} of={4} />

      <div className="mt-5 space-y-3">
        {split.groups.map((group) => {
          const members = group.memberIds
            .map((id) => byId.get(id))
            .filter((person): person is ClaimPerson => Boolean(person));
          const taken = members.filter((person) => person.name !== null).length;
          const samples = members
            .slice(0, 3)
            .map((person) => ({ person, crop: cropsFor(person, 1)[0] ?? null }));
          return (
            <button
              key={group.key}
              type="button"
              onClick={() => onPick(group.key)}
              className="flex w-full items-center gap-3 rounded-2xl border border-line bg-surface p-3 text-start transition-colors hover:border-muted-text"
            >
              <span
                aria-hidden="true"
                className="h-12 w-12 shrink-0 rounded-xl border border-line"
                style={{ backgroundColor: group.swatch }}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-sm font-semibold text-text">
                  {copy.kit.players(members.length)}
                </span>
                <span className="flex flex-wrap gap-1.5">
                  <Chip tone="turf">{copy.kit.unclaimed(members.length - taken)}</Chip>
                  {taken > 0 && <Chip>{copy.kit.found(taken)}</Chip>}
                </span>
              </span>
              <span className="flex shrink-0 gap-1">
                {samples.map(({ person, crop }) => (
                  <span key={person.id} className="block w-9">
                    {crop
                      ? <CropTile jpeg={crop.jpeg} alt="" />
                      : <CropPlaceholder label="" />}
                  </span>
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </ClaimScreen>
  );
}

/* ==================================================================== 4/5 */

export function GalleryScreen({
  copy,
  people,
  ungrouped,
  frameRate,
  matchOffset,
  yourIdentityId,
  cropsFor,
  canChangeKit,
  onChangeKit,
  onPick,
  onChain,
  saveError,
}: {
  copy: ReturnType<typeof useClaimCopy>;
  people: ClaimPerson[];
  ungrouped: boolean;
  frameRate: number;
  matchOffset: number;
  yourIdentityId: string | null;
  cropsFor: (person: ClaimPerson, count?: number) => Array<{ jpeg: string; frame: number }>;
  canChangeKit: boolean;
  onChangeKit: () => void;
  onPick: (person: ClaimPerson) => void;
  onChain: () => void;
  saveError: string | null;
}) {
  const clock = { frameRate, matchOffset };
  const unit = { minutes: copy.locale === "ar" ? "د" : "min", seconds: copy.locale === "ar" ? "ث" : "s" };
  const available = people.filter((person) => person.name === null || person.id === yourIdentityId);

  return (
    <ClaimScreen
      footer={
        <div className="space-y-2">
          {canChangeKit && <SecondaryAction onClick={onChangeKit}>{copy.gallery.changeKit}</SecondaryAction>}
          <QuietAction onClick={onChain}>{copy.gallery.findInVideo}</QuietAction>
        </div>
      }
    >
      <Eyebrow>{copy.gallery.eyebrow}</Eyebrow>
      <ScreenTitle>{copy.gallery.title}</ScreenTitle>
      <Lead>{copy.gallery.lead}</Lead>
      <ProgressRail step={2} of={4} />

      {ungrouped && (
        <p className="mt-4 rounded-2xl border border-violet/40 bg-violet/10 p-3 text-xs leading-5 text-[#A98CFF]">
          {copy.locale === "ar"
            ? "هالمباراة لسا ما انجمعت لاعبين، فممكن تشوف حالك بأكتر من صف. اختار الأوضح وبنكمّل من هناك."
            : "This match hasn't been grouped into players yet, so you may appear in more than one row. Pick the clearest one and we carry on from there."}
        </p>
      )}

      {saveError && (
        <div className="mt-4">
          <StateBlock tone="failed" title={copy.common.saveFailed} body={saveError} />
        </div>
      )}

      {available.length === 0 ? (
        <div className="mt-4">
          <StateBlock
            title={copy.gallery.none}
            body={copy.gallery.noneDesc}
            action={<SecondaryAction onClick={onChain}>{copy.gallery.findInVideo}</SecondaryAction>}
          />
        </div>
      ) : (
        <ul className="mt-4 space-y-3">
          {people.map((person) => {
            const crops = cropsFor(person, 6);
            const taken = person.name !== null;
            const isYou = person.id === yourIdentityId;
            return (
              <li
                key={person.id}
                className={`rounded-2xl border bg-surface p-3 ${isYou ? "border-turf" : "border-line"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Chip tone={isYou ? "turf" : "muted"}>
                      {copy.gallery.onCamera(formatDuration(person.onCameraSeconds, unit))}
                    </Chip>
                    <Chip>
                      {copy.gallery.seenBetween(
                        formatClock(displaySecondsForFrame(person.firstFrame, clock)),
                        formatClock(displaySecondsForFrame(person.lastFrame, clock)),
                      )}
                    </Chip>
                  </div>
                </div>

                <div className="mt-2.5 grid grid-cols-6 gap-1.5">
                  {Array.from({ length: 6 }, (_, index) => {
                    const crop = crops[index];
                    return crop
                      ? <CropTile key={index} jpeg={crop.jpeg} alt="" struck={taken && !isYou} />
                      : <CropPlaceholder key={index} label="" />;
                  })}
                </div>

                <div className="mt-2.5">
                  {isYou ? (
                    <Chip tone="turf">{copy.gallery.takenByYou}</Chip>
                  ) : taken ? (
                    <Chip>{copy.gallery.takenBy(person.name ?? "")}</Chip>
                  ) : (
                    <RowAction onClick={() => onPick(person)}>{copy.gallery.thisIsMe}</RowAction>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
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
 * claim. Cancel here returns to the gallery having written nothing.
 */
export function NameDialog({
  copy,
  defaultName,
  saving,
  onCancel,
  onConfirm,
}: {
  copy: ReturnType<typeof useClaimCopy>;
  defaultName: string;
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

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) { setError(copy.name.empty); return; }
    if (trimmed.length > 40) { setError(copy.name.tooLong); return; }
    onConfirm(trimmed);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-void/80 px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-10">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={copy.name.title}
        className="w-full max-w-[408px] rounded-2xl border border-line bg-surface p-5"
      >
        <p className="font-display text-lg font-bold text-text">{copy.name.title}</p>
        <p className="mt-1.5 text-sm leading-6 text-muted-text">{copy.name.lead}</p>
        <input
          ref={inputRef}
          value={name}
          onChange={(event) => { setName(event.target.value); setError(null); }}
          onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
          placeholder={copy.name.placeholder}
          maxLength={60}
          className="mt-4 h-12 w-full rounded-xl border border-line bg-raised px-4 text-base text-text outline-none focus:border-turf"
        />
        {error && <p className="mt-2 text-xs text-live" role="alert">{error}</p>}
        <div className="mt-4 space-y-2">
          <PrimaryAction onClick={submit} disabled={saving}>
            {saving ? copy.common.saving : copy.name.save}
          </PrimaryAction>
          <QuietAction onClick={onCancel}>{copy.name.cancel}</QuietAction>
        </div>
      </div>
    </div>
  );
}
