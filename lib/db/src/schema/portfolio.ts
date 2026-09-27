import { index, integer, pgTable, serial, text, boolean } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const portfolioHistoryTable = pgTable(
  "portfolio_history",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    teamName: text("team_name").notNull(),
    roleLabel: text("role_label").notNull(),
    startYear: integer("start_year").notNull(),
    endYear: integer("end_year"),
    isCurrent: boolean("is_current").notNull().default(false),
    displayOrder: integer("display_order").notNull().default(0),
  },
  (table) => ({
    userOrderIdx: index("portfolio_history_user_order_idx").on(table.userId, table.displayOrder),
  }),
);

export type PortfolioHistoryRow = typeof portfolioHistoryTable.$inferSelect;