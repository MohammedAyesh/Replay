import { asc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { z } from "zod";
import { academyAdTemplatesTable, db, type AcademyAdTemplate } from "@workspace/db";
import { adminAccess, intParam, ownerAccess, sendFailure } from "../lib/meta/routeAccess";

/**
 * Ready-made campaigns Replay writes (Admin → Meta ads → Templates). An owner picks one and the
 * ad builder starts filled in: goal, text versions in Arabic and English, budget, length,
 * audience and form questions. "{academy}" in a text becomes the academy's name.
 */
const router: IRouter = Router();

type Variant = { locale: "ar" | "en"; headline: string; primaryText: string };

const DEFAULTS: Array<Omit<typeof academyAdTemplatesTable.$inferInsert, "id">> = [
  {
    key: "registration_open",
    title: "Registration is open",
    titleAr: "التسجيل مفتوح",
    description: "A new season or term. Parents message you on WhatsApp.",
    descriptionAr: "موسم أو فصل جديد. الأهالي بيراسلوك على واتساب.",
    goal: "whatsapp",
    variants: [
      { locale: "ar", headline: "التسجيل مفتوح في {academy}", primaryText: "سجّل ابنك بأكاديمية {academy} ⚽ تدريب منظّم، مدربين مؤهلين، وكل حصة متصوّرة بتقدر تشوفها على التطبيق. راسلنا على واتساب واحجز مكانه." },
      { locale: "ar", headline: "الأماكن محدودة", primaryText: "بدأ التسجيل للموسم الجديد بـ{academy}. فئات عمرية من ٥ سنين. اضغط وراسلنا على واتساب لتعرف المواعيد والأسعار." },
      { locale: "en", headline: "Registration open at {academy}", primaryText: "Sign your child up at {academy} ⚽ Structured training, qualified coaches, and every session recorded so you can watch it in the app. Message us on WhatsApp to book a place." },
    ] satisfies Variant[],
    dailyBudgetFils: 5000,
    days: 14,
    ageMin: 25,
    ageMax: 50,
    radiusKm: 10,
    sortOrder: 1,
  },
  {
    key: "free_trial",
    title: "Free trial session",
    titleAr: "حصة تجريبية مجانية",
    description: "The easiest yes for a parent: one free session.",
    descriptionAr: "أسهل قرار للأهل: حصة وحدة مجاناً.",
    goal: "whatsapp",
    variants: [
      { locale: "ar", headline: "أول حصة علينا", primaryText: "جيب ابنك يجرّب حصة مجانية بأكاديمية {academy} ⚽ بنصوّر الحصة وبتشوف أداءه على التطبيق. راسلنا على واتساب لنحجزله." },
      { locale: "ar", headline: "حصة تجريبية مجانية", primaryText: "ابنك بحب الكورة؟ خليه يجرّب معنا مجاناً بـ{academy}. اضغط وراسلنا على واتساب." },
      { locale: "en", headline: "First session's on us", primaryText: "Bring your child for a free trial session at {academy} ⚽ We record it, so you can watch how they did in the app. Message us on WhatsApp to book." },
    ] satisfies Variant[],
    dailyBudgetFils: 4000,
    days: 10,
    ageMin: 25,
    ageMax: 50,
    radiusKm: 8,
    sortOrder: 2,
  },
  {
    key: "summer_camp",
    title: "Summer camp",
    titleAr: "المعسكر الصيفي",
    description: "A sign-up form with the child's age and preferred time.",
    descriptionAr: "نموذج تسجيل فيه عمر الطفل والوقت المناسب.",
    goal: "lead_form",
    variants: [
      { locale: "ar", headline: "المعسكر الصيفي بـ{academy}", primaryText: "صيف كله كورة ⚽ تدريب يومي، مباريات، وكل يوم متصوّر. عبّي النموذج ورح نتواصل معك على واتساب." },
      { locale: "en", headline: "Summer camp at {academy}", primaryText: "A summer of football ⚽ Daily training, matches, and every day recorded. Fill in the form and we'll message you on WhatsApp." },
    ] satisfies Variant[],
    questions: [
      { label: "عمر الطفل", options: ["٥–٧", "٨–١٠", "١١–١٣", "١٤+"] },
      { label: "الوقت المناسب", options: ["الصبح", "العصر", "المسا"] },
    ],
    dailyBudgetFils: 6000,
    days: 21,
    ageMin: 25,
    ageMax: 50,
    radiusKm: 12,
    sortOrder: 3,
  },
  {
    key: "new_age_group",
    title: "New age group",
    titleAr: "فئة عمرية جديدة",
    description: "Fill a new squad: under-8s, girls, goalkeepers…",
    descriptionAr: "عبّي فريق جديد: تحت ٨، بنات، حراس مرمى…",
    goal: "whatsapp",
    variants: [
      { locale: "ar", headline: "فريق جديد بـ{academy}", primaryText: "فتحنا فئة عمرية جديدة بأكاديمية {academy} ⚽ الأماكن محدودة. راسلنا على واتساب لتعرف التفاصيل." },
      { locale: "en", headline: "A new squad at {academy}", primaryText: "We've opened a new age group at {academy} ⚽ Places are limited. Message us on WhatsApp for the details." },
    ] satisfies Variant[],
    dailyBudgetFils: 4000,
    days: 14,
    ageMin: 25,
    ageMax: 50,
    radiusKm: 10,
    sortOrder: 4,
  },
  {
    key: "holiday_camp",
    title: "Holiday camp",
    titleAr: "معسكر العطلة",
    description: "Winter or Eid holidays: a short camp, sign-up form.",
    descriptionAr: "عطلة الشتوية أو العيد: معسكر قصير مع نموذج تسجيل.",
    goal: "lead_form",
    variants: [
      { locale: "ar", headline: "معسكر العطلة بـ{academy}", primaryText: "خلّي العطلة كورة ⚽ معسكر قصير بأكاديمية {academy}، تدريب ومباريات وكل يوم متصوّر. عبّي النموذج ورح نتواصل معك." },
      { locale: "en", headline: "Holiday camp at {academy}", primaryText: "Make the holiday all about football ⚽ A short camp at {academy}: training, matches, every day recorded. Fill in the form and we'll be in touch." },
    ] satisfies Variant[],
    questions: [{ label: "عمر الطفل", options: ["٥–٧", "٨–١٠", "١١–١٣", "١٤+"] }],
    dailyBudgetFils: 5000,
    days: 10,
    ageMin: 25,
    ageMax: 50,
    radiusKm: 12,
    sortOrder: 5,
  },
];

/** The first time anyone looks, Replay's starter set goes in; after that admins own the list. */
async function seedOnce(): Promise<void> {
  const [any] = await db.select({ id: academyAdTemplatesTable.id }).from(academyAdTemplatesTable).limit(1);
  if (any) return;
  await db.insert(academyAdTemplatesTable).values(DEFAULTS).onConflictDoNothing();
}

function view(t: AcademyAdTemplate, admin = false) {
  return {
    id: t.id,
    key: t.key,
    title: t.title,
    titleAr: t.titleAr,
    description: t.description,
    descriptionAr: t.descriptionAr,
    goal: t.goal,
    variants: t.variants as Variant[],
    questions: (t.questions ?? []) as Array<{ label: string; options?: string[] }>,
    dailyBudget: t.dailyBudgetFils / 1000,
    days: t.days,
    ageMin: t.ageMin,
    ageMax: t.ageMax,
    radiusKm: t.radiusKm,
    imageData: t.imageData,
    ...(admin ? { isActive: t.isActive, sortOrder: t.sortOrder } : {}),
  };
}

router.get("/academy/console/academies/:academyId/ads/templates", async (req, res): Promise<void> => {
  if (!(await ownerAccess(req, res))) return;
  try {
    await seedOnce();
    const rows = await db.select().from(academyAdTemplatesTable).where(eq(academyAdTemplatesTable.isActive, true))
      .orderBy(asc(academyAdTemplatesTable.sortOrder), asc(academyAdTemplatesTable.id));
    res.json(rows.map((t) => view(t)));
  } catch (error) {
    sendFailure(res, error, "Listing ad templates failed");
  }
});

const TemplateBody = z.object({
  title: z.string().trim().min(1).max(80),
  titleAr: z.string().trim().max(80).nullable().optional(),
  description: z.string().trim().max(200).nullable().optional(),
  descriptionAr: z.string().trim().max(200).nullable().optional(),
  goal: z.enum(["whatsapp", "lead_form"]),
  variants: z.array(z.object({
    locale: z.enum(["ar", "en"]),
    headline: z.string().trim().min(1).max(40),
    primaryText: z.string().trim().min(1).max(600),
  })).min(1).max(6),
  questions: z.array(z.object({ label: z.string().trim().min(1).max(80), options: z.array(z.string().trim().min(1).max(80)).max(10).optional() })).max(5).optional(),
  dailyBudget: z.number().min(2).max(1000),
  days: z.number().int().min(1).max(90),
  ageMin: z.number().int().min(18).max(65),
  ageMax: z.number().int().min(18).max(65),
  radiusKm: z.number().int().min(1).max(80),
  imageData: z.string().max(4_000_000).regex(/^data:image\/(png|jpe?g|webp);base64,/).nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});

function values(body: z.infer<typeof TemplateBody>) {
  return {
    title: body.title,
    titleAr: body.titleAr ?? null,
    description: body.description ?? null,
    descriptionAr: body.descriptionAr ?? null,
    goal: body.goal,
    variants: body.variants,
    questions: body.goal === "lead_form" ? body.questions ?? [] : [],
    dailyBudgetFils: Math.round(body.dailyBudget * 1000),
    days: body.days,
    ageMin: Math.min(body.ageMin, body.ageMax),
    ageMax: Math.max(body.ageMin, body.ageMax),
    radiusKm: body.radiusKm,
    imageData: body.imageData ?? null,
    isActive: body.isActive ?? true,
    sortOrder: body.sortOrder ?? 0,
    updatedAt: new Date(),
  };
}

router.get("/admin/meta-ads/templates", async (req, res): Promise<void> => {
  if (!(await adminAccess(req, res))) return;
  try {
    await seedOnce();
    const rows = await db.select().from(academyAdTemplatesTable).orderBy(asc(academyAdTemplatesTable.sortOrder), asc(academyAdTemplatesTable.id));
    res.json(rows.map((t) => view(t, true)));
  } catch (error) {
    sendFailure(res, error, "Listing ad templates failed");
  }
});

router.post("/admin/meta-ads/templates", async (req, res): Promise<void> => {
  if (!(await adminAccess(req, res))) return;
  const body = TemplateBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    return;
  }
  try {
    const [row] = await db.insert(academyAdTemplatesTable).values(values(body.data)).returning();
    res.status(201).json(view(row, true));
  } catch (error) {
    sendFailure(res, error, "Creating an ad template failed");
  }
});

router.put("/admin/meta-ads/templates/:id", async (req, res): Promise<void> => {
  if (!(await adminAccess(req, res))) return;
  const id = intParam(req.params.id);
  const body = TemplateBody.safeParse(req.body ?? {});
  if (!id || !body.success) {
    res.status(400).json({ error: body.success ? "Invalid id" : body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    return;
  }
  try {
    const [row] = await db.update(academyAdTemplatesTable).set(values(body.data)).where(eq(academyAdTemplatesTable.id, id)).returning();
    if (!row) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    res.json(view(row, true));
  } catch (error) {
    sendFailure(res, error, "Saving an ad template failed");
  }
});

router.delete("/admin/meta-ads/templates/:id", async (req, res): Promise<void> => {
  if (!(await adminAccess(req, res))) return;
  const id = intParam(req.params.id);
  // Hidden rather than deleted when it's the last one, so the starter set doesn't come back.
  const all = await db.select({ id: academyAdTemplatesTable.id }).from(academyAdTemplatesTable);
  if (id && all.length === 1 && all[0].id === id) {
    await db.update(academyAdTemplatesTable).set({ isActive: false }).where(eq(academyAdTemplatesTable.id, id));
    res.status(204).send();
    return;
  }
  const [row] = id ? await db.delete(academyAdTemplatesTable).where(eq(academyAdTemplatesTable.id, id)).returning() : [];
  if (!row) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  res.status(204).send();
});

export default router;
