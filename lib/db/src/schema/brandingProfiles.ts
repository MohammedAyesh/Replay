import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import type { BrandingScopeType } from "./brandingAssets";

/**
 * What a field or an academy looks like on an exported clip: its crest, its
 * colour, its name in both languages and how to book it.
 *
 * The overlay and end-card rows in branding_assets are finished files somebody
 * made elsewhere. This is the other way of branding a clip: the export draws
 * the corner crest, the name bar and the end screen itself, from these values,
 * so a venue that has only ever sent a logo on WhatsApp still gets clips that
 * look like theirs.
 *
 * One row per scope, resolved academy → field → global like branding_assets.
 * scope_id is 0 for global, never NULL, for the same unique-index reason given
 * there.
 */
export const brandingProfilesTable = pgTable(
  "branding_profiles",
  {
    id: serial("id").primaryKey(),
    scopeType: text("scope_type").notNull().$type<BrandingScopeType>(),
    scopeId: integer("scope_id").notNull().default(0),
    nameEn: text("name_en").notNull().default(""),
    nameAr: text("name_ar"),
    /** One short line under the name on the sign-off screen, Ammani Arabic. */
    taglineAr: text("tagline_ar"),
    /** The venue's main colour, "#RRGGBB". Fills the band on the end screen. */
    primaryColor: text("primary_color").notNull().default("#2FD8C4"),
    /** Optional second colour: the highlighted stat and the academy stripe. */
    accentColor: text("accent_color"),
    bookingPhone: text("booking_phone"),
    instagram: text("instagram"),
    /** Pull-zone URL of a transparent PNG crest, uploaded through the console. */
    crestUrl: text("crest_url"),
    crestWidth: integer("crest_width"),
    crestHeight: integer("crest_height"),
    /**
     * Academy clips show a shirt number, not a name, unless this is on: most
     * academy players are children and the clip is meant to be shared.
     */
    showPlayerNames: boolean("show_player_names").notNull().default(false),
    updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopeUnique: uniqueIndex("branding_profiles_scope_unique").on(table.scopeType, table.scopeId),
  }),
);

export type BrandingProfileRow = typeof brandingProfilesTable.$inferSelect;
