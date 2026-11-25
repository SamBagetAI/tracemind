# Tracemind design

Every page in Tracemind follows this file. It has three parts:

1. **References:** ten real dev-tool sites and what makes each one work.
2. **Rules:** the rules that hold whichever direction is chosen.
3. **Directions:** three candidate directions, and the merge of them that was built (section 4).

> The mockups, the reference screenshots and the cold reviews mentioned below (`design/…`) are not in
> this repository: they were made from the author's own Claude Code sessions. The rules they led to are
> all written out here.

**Chosen direction: the merge (section 4).** The three candidates are in `design/mockups.html`, and
a cold review of them and the first app is in `design/REVIEW.md`.

The screenshots are in `design/refs/`, taken at 1440 px wide on 24 Nov 2026. Fonts, sizes and colors
were read from each live page's computed styles, not guessed from the image.

---

## 1. References

### Linear: linear.app (`refs/linear.png`)
- **Layout:** one left-aligned column, with a headline that takes about 60% of the width and nothing beside it. A
  thin row of customer logos, then a statement paragraph where the first sentence is white and the rest grey.
- **Type:** Inter Variable at weight 510, not 500. The headline is 64/64 with tracking at −1.4 px. Body is 15/24 at
  −0.165 px. Labels like "FIG 0.2" are set in Berkeley Mono at a tiny size.
- **Color:** a near-black background (`#08090A`), white text (`#F7F8F8`) and grey body (`#8A8F98`). Borders
  are white at 8% opacity, and there are almost no other colors.
- **Spacing:** sections are about 160 px apart, and everything hangs off one left edge.
- **Take:** the two-tone sentence (one point, then its explanation in grey), the in-between font weights, and
  borders that are barely there.
- **Leave:** Inter.

### Axiom: axiom.co (`refs/axiom.png`)
- **Layout:** the product is the hero. A real query bar, a three-pane explorer (dataset list, fields, results)
  and an agent panel docked on the right, all shown at a readable size.
- **Type:** Geist for everything except data, which is Berkeley Mono. The headline is 64 px at weight 500, −0.96 px.
  Body is 15/22.5 in white at 63% opacity, and controls are 13 px at weight 450.
- **Color:** an almost-black background (`lab 2.5`), with a single orange accent `#DA5C2B` used only on the main
  button. Everything else is grey.
- **Spacing:** dense inside the product (28–32 px rows, 6 px radius) and generous outside it.
- **Take:** the three-pane explorer with a docked panel on the right, one warm accent on near-black, and the
  monospace font kept for data only.

### PlanetScale: planetscale.com (`refs/planetscale.png`)
- **Layout:** a page that reads like a document. Plain paragraphs come first, then a huge bordered grid of
  customer logos, with no hero image and no cards.
- **Type:** everything is `ui-monospace` at 16/24. The "headline" is bold body-size text after an orange bar.
  Links are blue, and key terms are bold.
- **Color:** black background, white and light-grey text, light-grey grid lines (`#C1C1C1`), an orange call to
  action (`oklch .66 .24 39`) and a yellow announcement bar.
- **Spacing:** square corners everywhere, with 1 px grid lines doing the work that cards and shadows usually do.
- **Take:** prose instead of stat tiles, grid lines instead of cards, and the confidence to set everything
  in monospace.

### Langfuse: langfuse.com (`refs/langfuse.png`)
- **Layout:** docs-style, with three columns: a left rail of live numbers (GitHub stars, Q&A threads) and the
  changelog, a center column for content, and a right "On this page" index. The center frame has crop marks at
  its corners.
- **Type:** the display face is f37Analog (a rounded grotesk) at 68 px. Labels are Geist Mono at 11 px.
  Buttons show their keyboard shortcut ("Start free S").
- **Color:** warm paper (`#EDEDE8`), warm ink (`#222220`) and a highlighter yellow behind the key words, as a
  flat mark rather than a gradient.
- **Spacing:** tight 2 px radius, small type, and hairline borders.
- **Take:** the paper-and-highlighter color scheme, the three-column docs layout, numbers as a list in the rail
  instead of tiles, and keyboard hints on buttons.
- **Leave:** its Inter body text.

### Braintrust: braintrust.dev (`refs/braintrust.png`)
- **Layout:** a left-aligned hero with a strip of tick marks under it that reads like a trace. Then a full-bleed
  colored band holding a real trace table (Created, Name, Input, Output) next to a detail panel.
- **Type:** btSans (custom) at weight 400 and 60/60, so the headline is large but not bold. Body is 24/30.
- **Color:** white, black, and one saturated blue (`#2C1FEA`) used for whole bands, not for small details.
  A pink band follows.
- **Spacing:** pill buttons (24 px radius) and long blocks of solid color between sections.
- **Take:** the trace table in which each row shows input and output side by side, and the tick strip as a
  timeline graphic.

### Warp: warp.dev (`refs/warp.png`)
- **Layout:** a figure-style frame ("[ fig. 1a — the factory ]") holding a grid of task squares with a
  legend (queued, working, waiting, shipped). A file-tree-plus-YAML panel follows.
- **Type:** headlines in Azeret Mono at 54 px weight 400, and body in Matter at 14/21.
- **Color:** off-white with a faint grid, ink `#1A1522`, a blue for state and a yellow-green button (`#EDF872`).
- **Spacing:** dotted and hairline frames, with labels in brackets.
- **Take:** showing many runs as a grid of squares with a legend, and figure-style captions.

### Honeycomb: honeycomb.io (`refs/honeycomb.png`)
- **Layout:** a classic centered hero with a terminal transcript (Claude Code calling Honeycomb MCP) as its
  only image.
- **Type:** Poppins for headings and Roboto for body, both at 16/24.
- **Color:** white, a pale blue wash behind the hero, and one blue (`#0072C3`) for both the key word and the
  main button.
- **Spacing:** standard marketing rhythm, with 6 px radius.
- **Take:** using an agent transcript as the product image. It's honest about what the product does.
- **Leave:** the centered template layout, which is the generic one.

### Vercel: vercel.com (`refs/vercel.png`)
- **Layout:** a split hero, with a big headline on the left and a short list of what it's for on the right.
  Lots of empty black space.
- **Type:** Geist Sans and Geist Mono at small sizes (12–14 px) for everything that isn't a headline.
- **Color:** near-monochrome. The page frame around the dark hero is `#FAFAFA` with `#EBEBEB` borders, and blue
  appears only on focus.
- **Spacing:** buttons have 6 px radius and come in a filled and a ghost pair.
- **Take:** the monochrome discipline and the filled-plus-ghost button pair.
- **Leave:** the glowing triangle, because no glow is allowed here.

### Tailscale: tailscale.com (`refs/tailscale.png`)
- **Layout:** a centered headline, then a row of five product tabs where the selected one turns into a filled
  red card. Below that, a large panel with bullets on the left and a product screenshot plus a status card on the
  right.
- **Type:** headings in Inter at 500 and 64/70. Small caps-style labels in "mdio" mono at 12 px with +0.6 tracking.
- **Color:** warm off-white (`#F9F7F6`), warm black (`#2E2D2D`), with one deep red for the selected tab and the
  "PRODUCT" label.
- **Spacing:** 8 px radius, and a big rounded panel on a slightly darker background.
- **Take:** the status card (Metric and Status rows with colored dots), which is a calm way to show health.
  Also tabs that become the content.
- **Leave:** Inter.

### PostHog: posthog.com (`refs/posthog.png`)
- **Layout:** the site is a desktop, with app icons down both sides and the page inside a window. Product
  tabs sit inside a bordered frame.
- **Type:** RoundHog (custom) at weight 800 for headings, with yellow highlights behind phrases.
- **Color:** sage background (`#EEEFE9`), a mustard button (`#CD8407`), black outlines and photo backgrounds.
- **Spacing:** chunky, with real borders (black 1–2 px) and a button that has a solid "pressed" shadow instead of
  a glow.
- **Take:** personality through structure (windows, outlines) instead of decoration, and the solid offset
  shadow on the main button.
- **Leave:** the photos and mascots.

**Looked at and left out:**
- **Sentry:** purple everywhere, plus an illustration.
- **Fly.io:** a serif headline with an italic line.
- **Resend:** a serif headline in light grey on black.
- **Raycast:** mostly empty, with glow.
- **Railway:** a purple button and a serif headline.

All five break the bans below, or say little. Their screenshots stay in `refs/` for comparison.

---

## 2. Rules for every page

**Banned:**
- Inter (Linear, Tailscale and Langfuse use it; we don't).
- Purple gradients, or purple at all.
- Glow, blur halos, or glowing buttons.
- A serif headline with one word in italic.
- A row of stat cards. Numbers go in a sentence, a list with right-aligned figures, or a table.
- Anything that looks like a template AI landing page.

**What every page does:**
- **Show the product's data first.** Axiom, Braintrust and Warp lead with real data in real layouts,
  not illustrations. Every page opens on sessions, steps or issues, never on a summary.
- **One accent color, with one meaning:** something went wrong, or the one action on the page. Everything
  else is a neutral. Axiom and PlanetScale both do this.
- **Monospace for machine text:** commands, paths, ids, tool names and durations. Words written for people
  use the text face. If a direction chooses to set everything in mono (B), that's a whole-page decision,
  not a mix.
- **Borders before shadows:** hairline or 1 px borders separate things, as on Linear, PlanetScale and Langfuse.
  The only shadow allowed is a solid offset one on the single main button, PostHog-style.
- **Numbers line up:** use tabular figures and right-align them in lists and tables.
- **Two-tone sentences:** state the point, then explain it in grey, in one sentence (Linear).
- **Density:** about 28–32 px rows in lists and timelines. One screen of a session should show at least
  15 steps at 1440 × 900.
- **Errors are obvious without color:** use a mark (✕), the word, and the accent. Never rely on red alone.
- **Light and dark:** whichever direction is chosen, its tokens get a counterpart for the other scheme.

---

## 3. Directions (pick one)

Each one is drawn in `design/mockups.html` on the same real session, so they can be compared directly.

### A: Instrument (based on Axiom)
- **Look:** near-black, Geist and Geist Mono, one ember accent (`#DA5C2B`) for failures and the main action.
- **Layout:** a three-pane explorer. Sessions are listed on the left, the timeline sits in the center with
  line numbers like a code editor, and "What it knew" is docked on the right like Axiom's agent panel. A query
  bar at the top says which session is open and holds its key numbers as text.
- **Feels like:** a professional tool you leave open all day.

### B: Ledger (based on PlanetScale)
- **Look:** black, everything in one monospace font (JetBrains Mono), white text, blue links, orange for
  failures, and a yellow bar for the one thing that needs attention. Square corners and 1 px grid lines, with
  no cards.
- **Layout:** each page reads like a report. A paragraph states what happened in plain words with the
  numbers inline, then a gridded table of steps, then a gridded table of memory.
- **Feels like:** a terminal printout you can trust.

### C: Field notes (based on Langfuse)
- **Look:** warm paper and ink, a highlighter mark on what went wrong, Schibsted Grotesk for text and Geist
  Mono for labels and data. Crop marks frame the content.
- **Layout:** three docs-style columns. The left rail holds workspace numbers as a list and recent sessions, the
  center holds the session, and the right rail is "On this page", with an index of failures and memory.
- **Feels like:** an engineer's notebook, calm and easy to read.

---

## 4. The merge (built)

A cold review scored A and C 6.5 and B 6. None reached 7, and the review recommended merging them.
The app is built that way, in React with shadcn/ui components and Magic UI for two small motions.

**Taken from each:**
- **From A:** three panes on near-black. Sessions are on the left, the trace in the middle, and "What it knew"
  on the right. The list scrolls on its own, and the page does not.
- **From B:** quiet stretches fold into one row, e.g. "Show 8 steps that went fine · 4 Bash, 3 Read". Tool
  rows show input and result side by side.
- **From C:** a real title, a one-sentence diagnosis made of facts only, and the timeline idea, drawn as a
  time strip. Each step sits at its place on the session's clock, and failures are red.

**Fixed from the review:**
- **Type:** sans (Geist) for words, Geist Mono only for commands, paths, ids, numbers and durations.
- **Color:** red (`--fail`) means failure and nothing else. Links and selection are neutral, and selection is
  a 2px foreground rule. There are no pills, and status shows only when it is an exception
  ("resolved", "back after resolved").
- **Failures are shown once.** A failed step carries a 2px red rule and an ✕, with no fill. It says what went
  wrong in plain words and links to its issue ("issue #5 · 14 sessions"). The raw error is one click
  away, never printed twice.
- **Repeated failures collapse:** the same tool failing the same way in a row becomes one row ("Edit ×5").
- **One numbering scheme:** "step 5" for steps, "issue #12" for issues.
- **Issues are written for people** ("Refused by the auto-mode classifier") and grouped by cause across
  tools ("Bash: cat, git, node").
- **The overview opens on a sentence, not stat cards.** Below it:
  - a strip with one square per session per day, red if it hit an issue;
  - what keeps going wrong;
  - the latest sessions.
- **Rates show only where they mean something:** a tool's failure rate from 20 calls up. A memory file is
  marked only when sessions that used it went wrong 15 points more often than sessions overall.
- **Paths are shortened** to `~/…/project/memory/FILE.md`, with the file name first and the full path on hover.

**Motion (Magic UI):**
- **Blur-fade:** 0.25s and 4px, on page content.
- **Number ticker:** on the overview sentence. It always shows the real number after 1.2s, and from the start
  when the tab is hidden or the person prefers less motion.
- Nothing shimmers, glows or loops.

**Checked:**
- Every page at 375 px wide.
- Hover on every row and link: rows go to `--accent`, and links underline.
- Light mode follows the system, with dark as the default.

---

## 5. Round two (after the second review, 5/10)

`design/REVIEW-2.md` asked for three changes. Here is what was built:

**1. The session is one trace across the page.**
- The side panels are gone. Previous and next arrows (and the `[` `]` keys) move between sessions.
- What the agent knew is inline. Step 0 lists the instruction files loaded at the start, and memory read or written appears as a chip on the step where it happened.
- Every row uses the same columns: step, time, tool (120 px), input, result, duration.
- A failed step shows what went wrong and its detail on up to three lines, with "issue #N · M sessions" on the line below. For classifier refusals, the reason tag replaces the boilerplate.
- The time strip has a legend, and its header uses one unit throughout: "37 steps · 32 tool calls · 10 failed".

**2. Issues have names and a history.**
- Issues are grouped by cause on the server (`src/core/describe.ts`, shared with the UI), with exact distinct-session counts.
- Overview and Issues read the same query over the same 30-day window, so their numbers match.
- Each row shows the top three tools, from a parser that skips flags, keywords, `$(…)` and `cd`. It also has a 30-day sparkline and first and last seen.
- An issue's page shows:
  - the full error from its latest session;
  - a 90-day chart;
  - what the sessions that hit it had loaded, compared with the other sessions in the same projects (from 3 sessions up).
- "Include one-offs" is a checkbox.

**3. A deliberate system.**
- **Width:** one page width (1,120 px).
- **Text:** muted 12 px table headers, so row titles are the brightest text. No explanatory paragraphs: the rules sit in the interface, as header tooltips, visible marks and thresholds.
- **Numbers:** thousands separators, and "—" for zero or nothing.
- **Color:**
  - red only above a threshold: 5+ sessions, or a 10%+ failure rate;
  - amber below that;
  - a green tick for a clean session;
  - green for what Tracemind adds to a file.
- **Session rows** carry a 120 px failure strip that matches the session page's time strip. It replaces the Failed and Issues columns.

**Suggestions (new page).** Changes to how Claude is used, made from what keeps going wrong over 90 days:

| Kind | What it does |
|---|---|
| Rule | Adds a line to the global `~/.claude/CLAUDE.md`, or to a project's CLAUDE.md or AGENTS.md (production data, per project). |
| Routine | Adds a SessionStart hook that runs `tracemind context`, so each new session hears the problems that keep happening in its own project. |
| Connect a tool | Steps for Claude to sign a connector in. |
| Trim a file | A prompt for Claude to shorten an instruction file that is too big. |
| Find the cause | A prompt for Claude about a recurring problem no rule covers yet. |
| Habit | A tip; nothing to apply. |

How a suggestion behaves:
- A rule or routine opens a preview first. The preview shows the end of the real file with the added lines, or the hook plus what a real project's session would be told.
- Applying keeps a backup, and Undo takes out exactly what was added.
- Once applied, the suggestion shows how many sessions hit the problem in the 30 days before and how many since.
- Files are changed only by the local app, on localhost, from this page; the server picks the file. A shared server only offers the prompts.

**Motion (Magic UI):** blur-fade on content, and the number ticker on the overview sentence. Neither loops or glows.

**Checked:** every page at 375 px (none is wider than the screen), hover on rows (`--accent`) and links (underline), and light and dark.

---

## 6. Round three (after the third review, 5/10)

`design/REVIEW-3.md` found counts for the same problem disagreeing from page to page. They came from
different, unlabelled windows: all-time on the session page, 90 days on Suggestions, 30 on Issues.

**Fixes:**
- **One window for every count.** A selector in the top bar (7, 30 or 90 days, remembered in the browser) sets
  the window for every page and every API call. Each count carries its window: "4 sessions · 30d" in rows,
  "Sessions · 30d" in headers.
- **All-time numbers say so.** "First ever" is all-time, and an issue shows "N · 30d · M all time". A session
  older than the window keeps all-time issue counts, labelled "all time". A count of "0 sessions" for an issue
  that very session hit would be wrong.
- **Errors are named by their error, not by file content.** A tool's own error message is used as it is. Then
  comes a line shaped like an error report (`prog: …`, `Error: …`, `zsh:1: …`, a compiler location followed by
  error), then an error-like line among the last three, then the exit code. grep matches, code, list items and
  headings never become a title, and a Python traceback is named by its exception.
- **Tool inputs without a known field** show their first readable text instead of raw JSON.
- **Suggestions are a review queue.**
  - Tabs: To review, Applied, Dismissed.
  - Items are grouped by where the change goes: global CLAUDE.md, a project's instruction file, Claude Code
    settings, connectors, file size, needs investigation, habits.
  - One main button per row: Apply (previewed) or Copy prompt. Each rule shows the lines it adds and links to its issue.
  - Investigations are one row until opened.
  - "Seen in" lists each session once.
- **Overview opens on the next change** worth making: the first rule or hook Tracemind can apply.
- **Honest comparisons.**
  - On an issue page, a loaded file is listed only if 3+ sessions with the issue had it and the shares differ by
    20+ points. It's written as "4 of 14" against "1 of 87". Otherwise the page says nothing stands out.
  - Memory compares each file with the share of all sessions that hit an issue ("+10 pts"), and says
    "too few" under 3 sessions.
  - Tools come in three tiers:
    1. tools with 20+ calls, by the lower end of their failure rate's 90% range;
    2. tools with fewer calls that failed;
    3. tools that never failed.
- **Monospace is for code only:** tool names, commands, paths, branches and errors. Labels, dates, counts,
  breadcrumbs and legends are in the sans font, with even-width figures.
- **Phones get a menu with all six pages,** and a session row puts its command on its own line.
- **The session pager reads "27 of 128, newest first"** and gets its own row on phones.
- **Keyboard hints are real keys.**

---

## 7. Round four (after the fourth review, 6/10)

`design/REVIEW-4.md` asked for one source of truth for every number, the loop from issue to fix to
effect on one screen, and visuals that can be read instead of only looked at.

**One cause, one count.**
- An issue link opens its cause: every variant of the same problem, across tools.
- The Issues list, the cause page, its history and the sessions list all come from one query in the same
  window. A test checks that the list count, the page count and the history total are the same number.
- Session pages show each failure's cause by name, with the cause's count.
- First seen is the start of the earliest session, whatever order sessions were saved in. 71 issues had a
  later date from import order; the database repairs this when it opens.
- The session pager walks the sessions in the window and says so ("3 of 21 in the last 30 days"). A session
  outside the window says it is browsing all sessions.
- The global CLAUDE.md is often not recorded in Claude Code's transcripts, so its count is a lower bound.
  Memory says this rather than showing it as fact.

**The loop on one screen.**
- A cause page opens on its suggested fix, with Apply, or with its effect once applied.
- The Issues list has a Fix column ("fix ready", "applied").
- The Overview opens on the next change, applied from there, and ends with "Changes you made", with
  before and since numbers.
- The session-start hook is not counted as a fix for any one cause.
- A change is written out before Apply. A rule shows as the sentence it adds and the file it goes into; the
  hook shows its `settings.json` line and what a real project's session would be told. Diffs in the preview
  have a separate gutter column, so "+" and the list mark no longer run together.

**Readable marks.**
- Heat strips replace sparklines: one cell per day, darker for more sessions, with the day and count on hover.
- Failures per session are a bar scaled to the busiest session, with the number.
- The Overview chart has a count axis and a date each week.
- Tools shows a "few calls" badge under 20 calls, and the ranking is in the page lead.
- Memory folds files used in fewer than 3 sessions into one line, and names its sections for what they are:
  "Loaded at session start", "Read or written by the agent".

**Identity.** The mark is a small time strip: a prompt, steps and one failure, as on a session page. It is
the logo and the favicon.

**Smaller fixes.**
- Step numbers have thousands separators.
- The session trace stays inside the page column, and the tool column is wider.
- A failure run in the diagnosis is the same tool failing the same way: "Edit failed 5 times in a row",
  not 7 across two different errors.
- The inert account text is out of the header.
- On phones the pager sits below the title, and header tooltips lose their dotted underline (no hover on touch).

## 8. Round five (after the fifth review, 5/10)

The review's three changes were: one fix queue as the Overview, a data-trust pass with a test for each
number, and the session page as a real trace viewer.

**Every number agrees with the list it links to.**
- The headline, the chart and the Sessions list count a session by when it started. The headline once
  counted by end time (22 against 16 in the chart).
- Each headline count is a link: "11 hit an issue" opens Sessions filtered to those 11 sessions.
- The Sessions list follows the window picked in the top bar.
- "Fix ready" uses the same window as the Suggestions page (it was once a year against 30 days).
- Tool run times leave out time spent waiting for a person (questions, plans to approve, permission
  prompts). They show the median ("Typical") and the 95th percentile ("Slow", from 5 timed calls),
  not the average and the maximum.
- "When" means when a session was last active, on every page.
- `test/app.test.ts › numbers the pages show` checks the headline against the list, the trend and fix
  fields, and the tool time fields. The tests for waits and ranking are in core and trace-view.

**The Overview is the fix queue.** It shows the open changes, ranked by sessions affected. Each one is
written out in full (the lines it adds, or the hook and what a new session would be told) with Apply and
Dismiss. The Top issues table that repeated the Issues page is gone. Changes you made shows before and
since.

**One colour scale, with a legend wherever it is used.** Red means many, amber some, grey one or none.
Issues, Tools and Memory each say what "many" means on that page.
- Issues swaps the per-day strip for a trend against the period before (▲ / ▼ / new).
- Memory compares a file only from 20 sessions. Below that it shows raw counts, open, and says so.
  "Fewer issues than usual" is grey, not green: using a file does not make a session go well.
- Tools sorts the way its lead says: tools with 20+ calls that failed, by rate; then tools with fewer
  calls; then tools that never failed.
- Filters on every page use one toggle style ("Recurring / With one-offs" replaces a checkbox).
- The cause page shows labelled facts (Sessions · 30d, All time, First seen, Last seen) instead of one
  line joined with dots.

**The session page is a trace viewer.**
- A failed row always shows its chevron and "Open for the full command and error". Opened, it shows the
  input and the error in full, each with Copy.
- `j` / `k` (or the arrow buttons) move between failures, open each one and centre it. A run of repeats
  counts once. "Failure 3 of 8" sits next to the buttons.
- The time strip gives every step the same width by default, so a burst of fast failures is as visible
  as one long build. "By time" puts steps back on the clock.
- On wide screens a side panel lists the issues hit, with their counts and fix status (each one jumps to
  its step), the files loaded at the start, and the skills and memory used.
- On phones, commands wrap to two lines instead of being cut to one, and the row icon sits on the first line.

## 9. Round six (after the sixth review, 6/10)

**One count model.** Every page counts the sessions that *started* in the window, and everything else
is counted over those sessions.
- The rows on Tools add up to the Overview's tool calls and failures. Tools once counted steps by their own
  time, which pulled in steps from sessions that started earlier.
- Memory counts the same sessions.
- A session's failures are its failed tool calls on the list, the session page and the Overview.
  Interruptions are no longer counted in the list's bar.
- A session's issues are counted by cause, in the header and in the side panel.
- Every cause that a suggested change covers shows "fix ready". This includes the session-start brief, and
  the cause page then explains that the brief covers several causes.
- The test `adds the Tools rows up to the Overview's totals` checks these totals.

**Detail pages that show what happened.**
- A cause page lists what the error *said*: commands with the same message are one line naming their tools,
  with the five most common shown and the rest behind "N more".
- "Column does not exist" style errors are "Database query failed", no longer "File or folder not found".
- The header no longer mixes an all-time list of tools into the window's facts.
- Memory compares a file from 20 sessions. When the chosen window has fewer sessions than that in all, the
  page covers the last year and says so in its first sentence.

**The template layer is gone.**
- No blur-in and no count-up: the data is there when the page opens.
- IBM Plex Sans and IBM Plex Mono replace Geist.
- Red is the only warning colour: red past the threshold, plain below it. There are no legends, and a
  zero is a blank cell, not a dash.
- Leads state the finding: "preview_start fails most often: 4 of 33 calls (12%)…", "Refused by the
  auto-mode classifier is the most common…", "No file stands out…". The sort order moves to a tooltip.
- The trend column reads "▲ was 3" / "▼ was 10".
- The Overview shows the one next change and links to the rest. Every suggestion says why it is suggested.
- The brief says "This keeps going wrong" when it lists one problem.
- The agent's replies fold into quiet stretches, so a long session has a few folds instead of twenty.
- The Sessions count is said once.

This replaces the earlier rule "Magic UI for small animated details". The animations it gave were
landing-page effects on a debugging tool.

## 10. Round seven (after the seventh review, 6/10)

**Every issue has a name a person would use, or it has no row.**
- Eighteen more error families are named, for example "zsh read == as a command", "Browser element was
  not on the page", "Module not found" and "Worked outside its git worktree".
- A batch tool's "[navigate] navigated to …" lines report steps that worked, and never name an error.
- A named issue is one issue whatever kind it was filed under, so the auto-mode refusal is no longer listed twice.
- Errors with no name yet sit together at the bottom of Issues, behind one line, as the text the tools
  printed. Their own page is titled "Error without a name yet".
- In the last 30 days: 15 named issues in the list, and 9 unnamed in the folded list.

**One word per idea: Issue → Fix.** The page is called Fixes (its URL is /fixes, and /suggestions still works).
- Only the Fixes page shows a fix's full card, with its diff and Apply.
- Overview ("Fixes to review") and the issue page show each fix in one line, with what it changes, how
  many issues it covers and how many sessions it would help, and a link to its card.
- A rule fix also shows its line on the issue page, since that line is this issue's own.
- The caveat paragraphs are gone.

**Labels that are true.**
- An issue page's sessions are sorted by when each was last active, as the column says.
- Memory stays on the window you picked, with plain counts (sessions, reads, writes, last used) and a
  lead naming what was used most.
- The "what those sessions had loaded" table and Memory's "vs all sessions" column are gone: long
  sessions both load more files and hit more issues, so they showed session length, not a cause.
- An issue's facts are one sentence instead of four labelled boxes.

**Parts of its own.**
- Table headers carry their unit ("% failed", "Median time", "Slowest 5%", "Sessions · prev 30d"), and the
  dotted tooltips are gone. Tools says its rules in one line above the table.
- "few calls" is plain muted text, not a pill.
- Each session row shows where along the session its tool calls failed, the same picture as the strip
  at the top of the session page. Overview lists the latest five sessions with that strip.

## 11. UX references (how the product works, not how it looks)

Five products that do part of Tracemind's job well, and the one idea each lends.

| Product | What it does well | The idea for Tracemind |
|---|---|---|
| [Linear triage](https://linear.app/docs/triage) | New work lands in one queue, and each item is decided with one key: accept (1), decline (2), duplicate (3), snooze (H). | Issues and fixes are decisions to make, not pages to browse. A queue you empty. |
| [Sentry issue details](https://docs.sentry.io/product/issues/issue-details) | One page per issue: the stack trace, the [breadcrumbs](https://docs.sentry.io/product/error-monitoring/breadcrumbs) that led to it, and a [suggested fix](https://docs.sentry.io/product/ai-in-sentry/seer/issue-fix) you can apply, open as a PR or hand to a coding agent. | The steps before a failure are its breadcrumbs, and a fix can go straight to Claude. |
| [Honeycomb BubbleUp](https://docs.honeycomb.io/investigate/analyze/identify-outliers/) | Select the bad part of a chart, and every field is compared between the selection and the baseline, most different first. | "What is different about the sessions that went wrong?" answered by comparison, with counts shown when samples are small. |
| [Raycast AI](https://manual.raycast.com/ai/quick-ai) | Type a question in the launcher and get the answer in place. [AI Extensions](https://manual.raycast.com/ai/ai-extensions) act on your tools, and show a preview to confirm before an action. | Ask first: the home is a question box answered from Tracemind's own MCP tools, and every change is confirmed. |
| [Dependabot pull requests](https://docs.github.com/en/code-security/concepts/supply-chain-security/about-dependabot-pull-requests) | Each change arrives as a pull request with its release notes and a compatibility score. [Research](https://arxiv.org/abs/2403.09012v1) on that score warns against showing it without its sample size. | A fix to your Claude setup is a pull request: a diff, the evidence, a confidence from how many sessions, and after merging, checks that say whether it worked. |

The five concepts in `design/ux-concepts.html` (kept local: it shows the author's sessions) each take one of these as the main idea.
