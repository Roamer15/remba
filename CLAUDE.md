# Remba — Coding Standards

These rules are derived from Robert C. Martin's *Clean Code* and adapted to this
TypeScript / NestJS codebase. Apply them when writing or refactoring code here.
When a rule conflicts with an existing NestJS idiom or a strong local pattern,
prefer consistency with the surrounding code and flag the tension.

## Names (Clean Code ch. 2 / N1–N7)
- Use intention-revealing, pronounceable, searchable names. No abbreviations or
  encodings (no Hungarian notation, no `m_`/`I` prefixes).
- Classes are nouns (`AgentService`, `WhatsappController`); methods are verbs
  (`buildWeeklyReport`, `fetchMediaAsDataUrl`).
- Name at the right level of abstraction; longer names for longer scopes.
- Names must describe side effects — don't hide them.
- Replace magic numbers with named constants (e.g. `DISPATCH_WINDOW_MINUTES`,
  `HISTORY_LIMIT`). No bare literals for meaningful values.

## Functions (ch. 3 / F1–F4, G30, G34)
- Keep functions small and doing **one thing** at **one level of abstraction**
  (the stepdown rule — a function's body reads as steps one level below its name).
- ≤ 3 arguments. Prefer an options object over long lists. **No flag arguments** —
  split into two functions instead.
- **No hidden side effects**; respect command/query separation (a function either
  does something or answers something, not both). No output arguments.
- Don't repeat yourself (DRY) — extract shared logic.

## Comments (ch. 4 / C1–C5)
- Prefer expressive code to comments. Good comments: legal headers, intent,
  warnings of consequences, `TODO`, public-API docs. Use them to explain *why*.
- Bad comments to avoid: redundant (restating the code), obsolete/misleading,
  noise, journal/attribution, and **commented-out code — delete it** (git remembers).
- Keep every comment accurate; a wrong comment is worse than none.

## Formatting (ch. 5)
- Defer to the project Prettier + ESLint config; run `npm run lint`/`format`.
- Vertical density for related lines, blank-line separation between concepts;
  declare variables close to first use; keep files focused and short.

## Objects, Data & Boundaries (ch. 6, 8)
- Respect the Law of Demeter — no train wrecks (`a.b().c().d()`); avoid transitive
  navigation (G36).
- Keep third-party libraries behind our own services (OpenAI → `OpenaiService`,
  WhatsApp/HTTP → `WhatsappService`, DB → `PrismaService`). Don't leak SDK types
  through the app. Use interfaces/DTOs for shapes (`src/**/interfaces`).

## Error Handling (ch. 7 / G4)
- Use exceptions, not error codes. Provide **context** when logging/throwing
  (`this.logger.error('<what failed for whom>', error)`).
- Don't return `null` or pass `null` around as a signal — prefer typed results,
  optional fields, empty collections, or throwing. (For nullable DB columns, an
  explicit `null` write is fine.)
- Don't silently swallow or override errors; handle, log, and degrade gracefully
  (e.g. localized fallback messages).

## Classes & Services (ch. 10)
- Single Responsibility Principle: each service has one reason to change —
  `AgentService` orchestrates, `tools.ts` performs actions, `AnalyticsService`
  reports, `SchedulerService` runs cron. Keep them small and cohesive.
- Depend on abstractions via NestJS DI (constructor injection); organize for change.

## Tests (ch. 9 / T1–T9, F.I.R.S.T.)
- Tests are **F.I.R.S.T.**: Fast, Independent, Repeatable, Self-validating, Timely.
- One concept per test; keep test code as clean as production code.
- Don't skip trivial tests; an ignored test is a question about an ambiguity.

## High-value general heuristics that apply here (G-series)
- G5 no duplication · G9 remove dead code · G11 be consistent · G19 use explanatory
  variables · G23 prefer polymorphism/lookup to large switch/if-else chains ·
  G25 named constants · G28 encapsulate conditionals · G30 functions do one thing.

## Project conventions (stay consistent with these)
- NestJS `@Injectable()` services; one `Logger` per class.
- `async/await` with `try/catch` + `logger.error(context, error)` at boundaries.
- All Prisma access through `PrismaService`.
- The agent owns all user-facing text; **tools return JSON data only** (no sends).
- Everything is bilingual EN/FR — respect the user's `language`.
