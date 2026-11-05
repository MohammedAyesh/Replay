import { Suspense, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Bot,
  Building2,
  CalendarDays,
  ChevronDown,
  Contact as ContactIcon,
  CreditCard,
  Globe,
  Instagram,
  LayoutDashboard,
  Megaphone,
  Menu,
  MessageCircle,
  MessagesSquare,
  Palette,
  ShieldCheck,
  Sparkles,
  Target,
  Trophy,
  UsersRound,
  Video,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useAuth } from "@/lib/auth";
import { readChatLink } from "@/lib/push-notifications";
import { useTranslation } from "@/i18n";
import { useVenueCopy } from "@/i18n/venue-strings";
import { cn } from "@/lib/utils";
import { ConsoleKindProvider } from "@/lib/console-kind";
import { useMyAcademyAccess } from "@/lib/academy-team-api";
import { useSetUpVenue, useVenueMemberships, type Customer } from "@/lib/venue-api";
import type { FieldSection } from "@/components/field-console/dashboard-section";
import { useInstagramCopy } from "@/i18n/instagram-strings";
import { Skeleton } from "@/components/field-console/shared";
import { lazyNamed, lazyPage } from "@/lib/lazy-page";

// Sections load when opened (lib/lazy-page.ts).
const AcademyChatsSection = lazyNamed(() => import("@/components/academy-console/chats-section"), "AcademyChatsSection");
const AcademyPeopleSection = lazyNamed(() => import("@/components/academy-console/people-section"), "AcademyPeopleSection");
const AcademyWhatsappSection = lazyNamed(() => import("@/components/academy-console/whatsapp-section"), "AcademyWhatsappSection");
const AcademyAdsSection = lazyNamed(() => import("@/components/academy-console/ads-section"), "AcademyAdsSection");
const AcademySocialSection = lazyNamed(() => import("@/components/academy-console/social-section"), "AcademySocialSection");
const AcademyProfileSection = lazyNamed(() => import("@/components/academy-console/profile-section"), "AcademyProfileSection");
const AcademyBrandingSection = lazyNamed(() => import("@/components/academy-console/branding-section"), "AcademyBrandingSection");
const AcademyTeamSection = lazyNamed(() => import("@/components/academy-console/team-section"), "AcademyTeamSection");
const AcademyCreativeHub = lazyNamed(() => import("@/components/creative-hub/hub"), "AcademyCreativeHub");
const BookingsSection = lazyNamed(() => import("@/components/field-console/bookings-section"), "BookingsSection");
const CustomersSection = lazyNamed(() => import("@/components/field-console/customers-section"), "CustomersSection");
const PitchesSection = lazyNamed(() => import("@/components/field-console/pitches-section"), "PitchesSection");
const PaymentsSection = lazyNamed(() => import("@/components/field-console/payments-section"), "PaymentsSection");
const AgentSection = lazyNamed(() => import("@/components/field-console/agent-section"), "AgentSection");
const WebsiteSection = lazyNamed(() => import("@/components/field-console/website-section"), "WebsiteSection");
const InstagramSection = lazyNamed(() => import("@/components/field-console/instagram-section"), "InstagramSection");
const DashboardSection = lazyNamed(() => import("@/components/field-console/dashboard-section"), "DashboardSection");
const Owner = lazyPage(() => import("@/pages/owner"));
const OwnerVar = lazyPage(() => import("@/pages/owner-var"));

const SECTIONS: FieldSection[] = ["footage", "dashboard", "bookings", "customers", "chats", "people", "agent", "whatsapp", "pitches", "payments", "website", "ads", "social", "instagram", "creative", "studio", "branding", "profile", "team"];
/** Which Team permission each screen falls under (lib/academyPermissions.ts on the server). */
const PERMISSION: Partial<Record<FieldSection, string>> = { customers: "people" };
const OWNER_ONLY: FieldSection[] = ["footage", "pitches", "payments", "website", "ads", "social", "instagram", "creative", "studio", "branding", "team"];
const SESSION_KEY = "replay_field_console_venue";

function readSelected(): number | null {
  try { return Number(sessionStorage.getItem(SESSION_KEY)) || null; } catch { return null; }
}

export default function FieldConsole() {
  const { isSignedIn, isLoading, isGuest } = useAuth();
  const { locale, setLocale } = useTranslation();
  const copy = useVenueCopy();
  const igCopy = useInstagramCopy();
  const [location, setLocation] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  // A notification opens /field/chats?a=<field>&phone=… (or &thread=…): that field, that chat.
  const [chatLink] = useState(readChatLink);
  const [selected, setSelected] = useState<number | null>(() => chatLink.academyId ?? readSelected());
  const [chatPhone, setChatPhone] = useState<string | null>(chatLink.phone);
  const [chatThread, setChatThread] = useState<number | null>(chatLink.thread);
  const [bookingDraft, setBookingDraft] = useState<{ pitchId?: number; name?: string; phone?: string } | null>(null);
  const memberships = useVenueMemberships(isSignedIn && !isGuest);
  const setUp = useSetUpVenue();
  const list = memberships.data?.memberships ?? [];
  const active = useMemo(() => list.find((m) => m.academyId === selected) ?? list[0], [list, selected]);
  const venueId = active?.academyId ?? null;
  const isOwner = active?.roles.includes("owner") ?? false;
  const access = useMyAcademyAccess(venueId);

  const section: FieldSection = useMemo(() => {
    const part = location.split(/[?#]/)[0].replace(/\/+$/, "").split("/")[2] as FieldSection | undefined;
    return part && SECTIONS.includes(part) ? part : "dashboard";
  }, [location]);

  // /field/footage/var/<id>: VAR for one booked match, inside the console.
  const varId = useMemo(() => {
    const m = location.split(/[?#]/)[0].match(/^\/field\/footage\/var\/(\d+)/);
    return m ? Number(m[1]) : null;
  }, [location]);

  const canSee = (s: FieldSection) => {
    if (s === "team" || s === "creative" || s === "studio" || s === "footage" || s === "instagram") return isOwner;
    if (isOwner) return true;
    const perm = PERMISSION[s] ?? s;
    return access.data ? access.data.sections.includes(perm) : !OWNER_ONLY.includes(s);
  };
  const manages = (s: FieldSection) => isOwner || Boolean(access.data?.manages.includes(PERMISSION[s] ?? s));

  const navigate = (next: FieldSection) => {
    setMobileOpen(false);
    setLocation(next === "dashboard" ? "/field" : `/field/${next}`);
  };
  const openChat = (phone: string) => { setChatPhone(phone); setChatThread(null); navigate("chats"); };

  useEffect(() => {
    if (!active || section === "dashboard") return;
    if (!isOwner && access.isLoading) return;
    if (!canSee(section)) navigate("dashboard");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, isOwner, section, access.data, access.isLoading]);

  if (isLoading || (isSignedIn && !isGuest && memberships.isLoading)) {
    return <div className="grid min-h-[100dvh] place-items-center bg-void px-5"><div className="w-full max-w-4xl"><Skeleton rows={4} /></div></div>;
  }
  if (!isSignedIn || isGuest) {
    return (
      <Splash title={copy.console.signInTitle} body={copy.console.signInBody}>
        <Button type="button" className="mt-7 min-h-12 w-full rounded-xl bg-floodlight font-bold text-void" onClick={() => setLocation("/sign-in?redirect_url=%2Ffield")}>{copy.console.signIn}</Button>
      </Splash>
    );
  }
  if (memberships.isError) {
    return <Splash title={copy.console.error} body=""><Button type="button" className="mt-6" onClick={() => void memberships.refetch()}>{copy.console.retry}</Button></Splash>;
  }
  if (!active) {
    if (memberships.data?.canSetUp) {
      const names = memberships.data.ownedFields.map((f) => f.name).join("، ");
      return (
        <Splash title={copy.console.setUpTitle} body={copy.console.setUpBody(names)}>
          <Button type="button" disabled={setUp.isPending} onClick={() => setUp.mutate(undefined, { onSuccess: (r) => { setSelected(r.academyId); try { sessionStorage.setItem(SESSION_KEY, String(r.academyId)); } catch { /* optional */ } } })} className="mt-7 min-h-12 w-full rounded-xl bg-floodlight font-bold text-void" data-testid="button-set-up-field">
            {setUp.isPending ? copy.console.settingUp : copy.console.setUp}
          </Button>
          {setUp.error && <p className="mt-3 text-sm text-red-400">{setUp.error.message}</p>}
        </Splash>
      );
    }
    return <Splash title={copy.console.noAccessTitle} body={copy.console.noAccessBody} />;
  }

  const groups: Array<{ label: string; items: Array<{ id: FieldSection; label: string; icon: typeof LayoutDashboard }> }> = [
    { label: copy.console.workspace, items: [
      { id: "dashboard", label: copy.nav.dashboard, icon: LayoutDashboard },
      { id: "bookings", label: copy.nav.bookings, icon: CalendarDays },
      { id: "customers", label: copy.nav.customers, icon: UsersRound },
      { id: "chats", label: copy.nav.chats, icon: MessagesSquare },
      { id: "people", label: copy.nav.people, icon: ContactIcon },
      { id: "agent", label: copy.nav.agent, icon: Bot },
      { id: "footage", label: copy.console.footage, icon: Video },
    ] },
    { label: copy.console.marketing, items: [
      { id: "ads", label: copy.nav.ads, icon: Target },
      { id: "social", label: copy.nav.social, icon: Instagram },
      { id: "instagram", label: igCopy.nav, icon: Megaphone },
      { id: "creative", label: copy.nav.creative, icon: Sparkles },
    ] },
    { label: copy.console.settings, items: [
      { id: "pitches", label: copy.nav.pitches, icon: Trophy },
      { id: "payments", label: copy.nav.payments, icon: CreditCard },
      { id: "website", label: copy.nav.website, icon: Globe },
      { id: "whatsapp", label: copy.nav.whatsapp, icon: MessageCircle },
      { id: "branding", label: copy.nav.branding, icon: Palette },
      { id: "profile", label: copy.nav.profile, icon: Building2 },
      { id: "team", label: copy.nav.team, icon: ShieldCheck },
    ] },
  ];

  const sidebar = (mobile: boolean) => (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex items-center justify-between border-b border-line px-5 py-5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-floodlight text-void"><Trophy className="h-5 w-5" /></span>
          <span className="min-w-0">
            <span className="block truncate font-display text-sm font-bold text-text">{active.academyName}</span>
            <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-text">{copy.console.title}</span>
          </span>
        </div>
        {mobile && <Button type="button" variant="ghost" size="icon" onClick={() => setMobileOpen(false)}><X className="h-5 w-5" /><span className="sr-only">{copy.console.closeMenu}</span></Button>}
      </div>
      {list.length > 1 && (
        <div className="border-b border-line p-4">
          <div className="relative">
            <select value={venueId ?? ""} onChange={(e) => { const id = Number(e.target.value); setSelected(id); try { sessionStorage.setItem(SESSION_KEY, String(id)); } catch { /* optional */ } navigate("dashboard"); }}
              className="min-h-11 w-full appearance-none rounded-xl border border-line bg-raised px-3 pe-9 text-sm font-semibold text-text">
              {list.map((m) => <option key={m.academyId} value={m.academyId}>{m.academyName}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-text" />
          </div>
        </div>
      )}
      <nav className="min-h-0 flex-1 overflow-y-auto p-3">
        {groups.map((g) => {
          const items = g.items.filter((i) => canSee(i.id));
          if (!items.length) return null;
          return (
            <div key={g.label} className="mb-3">
              <p className="px-3 pb-2 pt-1 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-text">{g.label}</p>
              <div className="space-y-1">
                {items.map(({ id, label, icon: Icon }) => (
                  <button key={id} type="button" onClick={() => navigate(id)} className={cn("flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-start text-sm font-semibold transition-colors", section === id ? "bg-turf/10 text-turf" : "text-muted-text hover:bg-raised hover:text-text")} data-testid={`nav-field-${id}`}>
                    <Icon className="h-4 w-4 shrink-0" />{label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </nav>
      <div className="border-t border-line p-4">
        <button type="button" onClick={() => setLocale(locale === "ar" ? "en" : "ar")} className="flex min-h-11 w-full items-center justify-between rounded-xl border border-line bg-raised px-3 text-sm font-semibold text-text hover:border-turf">
          <span>{copy.console.language}</span><span className="font-display text-xs tracking-[0.14em] text-turf">{locale.toUpperCase()}</span>
        </button>
      </div>
    </div>
  );

  const id = venueId!;
  return (
    <ConsoleKindProvider kind="venue">
      <div className="flex min-h-[100dvh] w-full bg-void text-text" dir={locale === "ar" ? "rtl" : "ltr"} data-testid="field-console">
        <aside className="hidden w-72 shrink-0 border-e border-line md:block">{sidebar(false)}</aside>
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side={locale === "ar" ? "right" : "left"} className="w-[min(88vw,20rem)] border-line bg-surface p-0 [&>button]:hidden">
            <SheetHeader className="sr-only"><SheetTitle>{copy.console.title}</SheetTitle><SheetDescription>{copy.console.title}</SheetDescription></SheetHeader>
            {sidebar(true)}
          </SheetContent>
        </Sheet>
        <main className="min-w-0 flex-1 bg-void">
          <header className="sticky top-0 z-20 flex min-h-16 items-center justify-end border-b border-line bg-void/90 px-5 backdrop-blur-md md:px-8">
            <Button type="button" variant="ghost" size="icon" className="absolute start-5 md:hidden" onClick={() => setMobileOpen(true)}><Menu className="h-5 w-5" /><span className="sr-only">{copy.console.openMenu}</span></Button>
            <Link href="/account" className="rounded-xl border border-line bg-surface px-3 py-2 text-xs font-semibold text-muted-text hover:text-text">{copy.console.account}</Link>
          </header>
          <div className="mx-auto max-w-6xl px-5 py-8 pb-14 md:px-8" key={id}>
            <Suspense fallback={<Skeleton rows={3} />}>
            {section === "dashboard" ? <DashboardSection venueId={id} onNavigate={navigate} />
              : section === "bookings" ? <BookingsSection venueId={id} onOpenChat={openChat} initial={bookingDraft} />
              : section === "customers" ? <CustomersSection venueId={id} onOpenChat={openChat} onBook={(c: Customer) => { setBookingDraft({ name: c.name ?? undefined, phone: c.phone, pitchId: undefined }); navigate("bookings"); }} />
              : section === "chats" ? <AcademyChatsSection academyId={id} isOwner={manages("chats")} canManageChats={isOwner || Boolean(access.data?.permissions.includes("chats.manage"))} initialPhone={chatPhone} initialSocialThreadId={chatThread} />
              : section === "people" ? <AcademyPeopleSection academyId={id} isOwner={manages("people")} onOpenChat={openChat} />
              : section === "agent" ? <AgentSection venueId={id} onOpenChat={openChat} onOpenWhatsapp={() => navigate("whatsapp")} />
              : section === "whatsapp" ? <AcademyWhatsappSection academyId={id} />
              : section === "pitches" ? <PitchesSection venueId={id} />
              : section === "payments" ? <PaymentsSection venueId={id} />
              : section === "website" ? <WebsiteSection venueId={id} />
              : section === "ads" ? <AcademyAdsSection academyId={id} onOpenChat={openChat} />
              : section === "instagram" ? <InstagramSection venueId={id} />
              : section === "social" ? <AcademySocialSection academyId={id} onOpenChat={(threadId) => { setChatThread(threadId); setChatPhone(null); navigate("chats"); }} />
              : section === "creative" ? <AcademyCreativeHub academyId={id} />
              // Studio is now the Creative hub's Clips and Quick posts tabs; old /field/studio links land on Clips.
              : section === "studio" ? <AcademyCreativeHub academyId={id} initialTab="clips" />
              : section === "branding" ? <AcademyBrandingSection academyId={id} />
              : section === "profile" ? <AcademyProfileSection academyId={id} />
              : section === "team" ? <AcademyTeamSection academyId={id} />
              : section === "footage" ? (varId ? <OwnerVar requestId={varId} onBack={() => setLocation("/field/footage")} /> : <Owner embedded onOpenVar={(requestId) => setLocation(`/field/footage/var/${requestId}`)} />)
              : null}
            </Suspense>
          </div>
        </main>
      </div>
    </ConsoleKindProvider>
  );
}

function Splash({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  const copy = useVenueCopy();
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-void px-5 py-10" dir={copy.locale === "ar" ? "rtl" : "ltr"} data-testid="field-console-splash">
      <div className="w-full max-w-md rounded-[28px] border border-line bg-surface p-7 text-center">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-floodlight text-void"><Trophy className="h-7 w-7" /></span>
        <p className="mt-4 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-text">{copy.console.title}</p>
        <h1 className="mt-3 font-display text-3xl font-bold tracking-tight text-text">{title}</h1>
        {body && <p className="mt-3 text-sm leading-6 text-muted-text">{body}</p>}
        {children}
      </div>
    </div>
  );
}
