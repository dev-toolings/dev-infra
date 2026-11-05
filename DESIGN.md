# DevHub Design System

DevHub has two surfaces with separate design rules:

- the control panel in `apps/web` (React, Vite, Tailwind v4), described first;
- the documentation site in `docs/`, described at the end.

## Control panel (`apps/web`)

### Source

The panel reuses the webcops design system (`webcops/packages/ui`). These files are
copies, adapted for DevHub:

- `src/tokens.css`: shared palette, radius and fonts. Change it only to stay in sync
  with webcops.
- `src/styles.css`: imports, plus DevHub-only surfaces (`panel`, `shell`, `log-*`).
- `src/components/ui/*`: primitives built on `radix-ui`, `class-variance-authority` and
  `tw-animate-css`.
- `src/components/brand/logo.tsx` and `public/favicon.svg`: the same radar mark.

DevHub-specific changes to the copied primitives, to keep when syncing again:

| Primitive | Change |
|---|---|
| `badge` | adds `muted`, `up`, `degraded`, `down` variants |
| `select` | trigger is `w-full` and truncates its value |
| `dialog` | content scrolls (`max-h-[calc(100dvh-2rem)] overflow-y-auto`) |
| `skeleton` | tone is `bg-foreground/[0.07]`, visible on cards and in dark mode |

### Direction

A quiet operations console for one developer on one machine. Neutral grayscale
surfaces, dense information, and color reserved for state. Nothing decorative.

### Color

- Neutral tokens carry the interface: `background`, `foreground`, `muted`, `border`,
  `primary` (near black in light mode, near white in dark mode).
- Color means state, never decoration. State colors are the status tokens of
  [BoardUI](https://www.boardui.com/components/color), built on the Tailwind palette.
  Their role per state below is a DevHub choice: BoardUI defines colors, not these states.
- Values live in `src/tokens.css`. Hex is the sRGB equivalent of the OKLCH source, and a
  percentage is the opacity.

| State | Badge variant | BoardUI color | Used for |
|---|---|---|---|
| Healthy | `up` | lime | running, ready, succeeded, validated |
| Stopped or warning | `degraded` | yellow | stopped, exited, paused, partially running, medium severity |
| Failing | `down` | rose | unhealthy, failed, critical and high severity |
| In progress | `info` | blue | starting, restarting, queued, operation running |
| Idle | `muted` | neutral | counts, never scanned |
| Neutral | `outline` | none | kinds, unknown or unavailable |

Status colors:

| Token | Light | Dark |
|---|---|---|
| `--status-up` | `#3c6300` | `#7ccf00` |
| `--status-up-bg` | `#d8f999` | `#192e03 60%` |
| `--status-degraded` | `#894b00` | `#f0b100` |
| `--status-degraded-bg` | `#fff085` | `#432004 60%` |
| `--status-down` | `#a50036` | `#ff2056` |
| `--status-down-bg` | `#ffccd3` | `#4d0218 60%` |
| `--status-info` | `#193cb8` | `#8ec5ff` |
| `--status-info-bg` | `#bedbff` | `#162456 60%` |
| `--status-unknown` | `#737373` | `#a1a1a1` |
| `--status-unknown-bg` | `#e5e5e5` | `#262626` |

Surfaces and text:

| Token | Light | Dark |
|---|---|---|
| `--background` | `#ffffff` | `#0a0a0a` |
| `--foreground` | `#0a0a0a` | `#fafafa` |
| `--card` | `#ffffff` | `#171717` |
| `--popover` | `#ffffff` | `#171717` |
| `--primary` | `#171717` | `#e5e5e5` |
| `--primary-foreground` | `#fafafa` | `#171717` |
| `--secondary` | `#f5f5f5` | `#262626` |
| `--muted` | `#f5f5f5` | `#262626` |
| `--muted-foreground` | `#737373` | `#a1a1a1` |
| `--accent` | `#f5f5f5` | `#262626` |
| `--destructive` | `#e7000b` | `#ff6467` |
| `--border` | `#e5e5e5` | `#ffffff 10%` |
| `--input` | `#e5e5e5` | `#ffffff 15%` |
| `--ring` | `#a1a1a1` | `#737373` |

- Log output sits on the dark `log-panel` surface in both themes.
- Do not add brand accents, gradients or tinted washes.

### Typography

- Inter Variable from `@fontsource-variable/inter`, served locally. The panel runs on
  loopback and makes no outbound request, so no font CDN.
- Page title: `text-sm font-semibold` in the header bar, with a `text-xs` description.
- Section heading (`ViewHeading`): `text-sm font-semibold`, `text-xs` muted description.
- Paths, IDs, ports and commands: monospace.

### Layout

- Shell: `SidebarProvider` with a floating sidebar that collapses to icons
  (`--sidebar-width: 244px`), on a `bg-muted` page.
- Content: `SidebarInset` with `m-2`, a rounded border and `shadow-xs`. A fixed header
  bar (`--header-height: 52px`) holds the sidebar trigger, the title and page actions.
- Body: one scroll area, `p-4`, `gap-4`.
- Projects: `/projects` is a grid of cards (two columns from `md`, three from `xl`, four
  from `110rem`), with Add existing and New project in the header bar. `/projects/:id` is
  one project in a `container mx-auto`: the header bar holds the breadcrumb and the project
  switcher, then come the project header, Components, and two tabs, Logs and Recent
  operations. The Logs tab fills the height left in the viewport.
- Containers: two columns from `xl`.
- Mobile: the sidebar becomes a sheet behind the header trigger. No horizontal overflow.

### Language

English and French. English text is the key (`t("Add project")`, `lib/i18n.ts`) and
`lib/messages.fr.ts` holds the French: a missing entry fails the typecheck. The default
follows the browser, and the session menu switches it. API text uses `translate()`.

### Components

- Buttons: `h-8` by default, `sm` (`h-7`) inside cards. One primary button per area.
- Cards: `rounded-xl`, hairline border, `shadow-xs`. `CardHeader` is a grid: add
  `flex flex-row` for a header that puts actions on the same line.
- Service and stack logos: `src/assets/services/*.svg`, shown through `ServiceIcon` as a
  mask so they follow the theme. Simple Icons (CC0), Mailpit and Dozzle from their
  projects. Add a file named after the service to add a logo.
- Session menu (sidebar footer): theme switch (light, dark, system) and Log out.
- Inventories (Containers, image scans): `StatTile` row that doubles as filters, a
  toolbar (search, filter, result count), then one table in a card
  (`components/views/inventory.tsx`). Rows show the name, one secondary line and the
  state; full IDs, every port and long lists go to a right `Sheet` opened from the row.
  Never put a long list in a `Select`: past about ten options, use a filterable table.
- Row actions are `outline`, `size="sm"`: a page with many rows has no primary button.
- Project page: the header shows one state for the project (`projectState`, Partial when
  only some components run) and acts on all components, with one primary button: Start,
  or Open app when everything runs. Open app shows only when the app can answer. Component
  rows share aligned columns (name, address, state, actions) and get icon actions, with a
  tooltip, only when the project has several components.
- New project (`components/views/create-project.tsx`): a workshop across the full width.
  On the left, in a column up to `36rem`, the steps (Project and stack, Services, Docker, Create;
  native mode skips Docker) with one primary button. On the right, the files the server
  would write for the exact form, in `CodeBlock`, with a `FileTree` whose files open beside it. Editing
  the Dockerfile turns that panel into a text area. There is no separate preview step.
- Release lines: a table of each component with its LTS, latest and other lines, the end
  of support and the CVE count from the last `devhub versions` report.
- Syntax colors in `CodeBlock` and file types in `FileTree` are the one exception to color
  meaning state. They reuse the status tokens and appear nowhere else.
- Versions (Maintenance tab, `components/views/versions-view.tsx`): an inventory as above,
  worst state first. End of life and vulnerable are `down`, ending soon and update
  available are `degraded`, a failed source or no lifecycle data is `outline`.
- Choices: all values visible in a segmented control when there are few, `Switch` for
  on or off. A `Select` is for long or path-like lists.
- Digest-pinned references (`name:tag@sha256:...`) show `name:tag` with a `pinned`
  badge; the short digest (`sha256:` plus 12 characters) goes on the secondary line.
- Theme: stored under `devhub-theme`, applied before the first render.
- Routing (`src/lib/router.ts`): every page has a URL (`/projects/:id`, `/containers`,
  `/logs/:id`, `/maintenance`, `/maintenance/remediation`). Navigation items are real
  links, so a new tab and back/forward work. Unknown paths go to `/projects`.

### States

Every view handles loading, empty and error explicitly.

- Loading: a skeleton that mirrors the layout it stands in for, from
  `components/views/skeletons.tsx`: same grid, same card structure, same field rows.
  Content then replaces it without a layout jump.
  - `ShellSkeleton` while the session is checked, `ProjectListSkeleton` and
    `ProjectDetailSkeleton`, `ContainersSkeleton`, `LogsSkeleton` on the log surface,
    `ScansSkeleton`.
  - When only part of a view is loading, use a field-level placeholder (status badge,
    readiness, image selector) and keep the rest interactive.
  - Never show "unavailable", "none" or an empty list while the data is still loading.
  - Spinners only inside a button for an action in progress, never for a page.
- Empty: `EmptyState`, dashed border, one sentence and at most one action.
- Error: `ErrorState` when the view has nothing to show, `ErrorToast` when content is
  already on screen: one toast per source, kept until closed.

### Motion

`tw-animate-css` for overlays (fade and zoom), `animate-pulse` for skeletons.
`prefers-reduced-motion` disables animations. Never animate layout properties.

### Copy

English, sentence case, direct and technical. No em dashes. Name the next action
when something fails.

### Accessibility

- Skip link to the content, `aria-current` on the active navigation item.
- Each skeleton is one `role="status"` region with a spoken label; its bars are
  `aria-hidden`.
- Visible focus rings on every control. Never rely on color alone: badges carry text.

## Documentation site (`docs/`)

### Direction

The DevHub documentation uses an Apple-inspired local developer aesthetic: clear, quiet, sharp, and premium without becoming decorative. The interface should feel like a native macOS utility page for infrastructure work.

Physical scene: a developer reads this on a laptop during the day while setting up multiple local branches. The page should reduce friction and make the workflow feel controlled.

### Color Strategy

Restrained. Use cool tinted neutrals with a single system-blue accent. Blue should stay under roughly ten percent of the page and mark actions, CLI terms, and small status elements.

Use OKLCH tokens from `docs/input.css`:

```css
--color-page: oklch(97.6% 0.004 250);
--color-panel: oklch(99.1% 0.003 250);
--color-window: oklch(96.7% 0.005 250);
--color-soft: oklch(94.2% 0.006 250);
--color-hairline: oklch(86.5% 0.008 250);
--color-graphite: oklch(21% 0.012 255);
--color-muted: oklch(48% 0.018 255);
--color-blue: oklch(58% 0.19 255);
--color-blue-strong: oklch(52% 0.21 255);
--color-blue-soft: oklch(93.5% 0.035 255);
--color-code: oklch(24% 0.016 255);
--color-code-text: oklch(92% 0.006 255);
```

Avoid pure black and pure white. Avoid warm beige, forest green, copper, amber, purple gradients, and broad color washes.

### Typography

Use the system font stack to stay close to native Apple surfaces:

```css
-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", ui-sans-serif, system-ui, "Segoe UI", sans-serif
```

Guidelines:

- Hero product name uses very large system type, semibold, tight negative tracking.
- Body copy is calm and readable, with line length under 75 characters where possible.
- Section headings use strong scale changes, not color decoration.
- Code uses SF Mono where available.

### Layout

- Maximum content width: `1120px`.
- Use one dominant hero idea, then documentation sections.
- Keep cards shallow and purposeful. Radius should stay at `rounded-lg`.
- Prefer hairline borders and subtle shadows over heavy containers.
- Tables and code blocks should remain practical and scannable.
- Mobile layout must keep the service preview readable without horizontal overflow.

### Components

#### Header

Sticky, translucent, hairline border, compact brand mark. Navigation stays quiet and text-only.

#### Buttons

Primary: blue pill with panel text. Secondary: panel pill with hairline border. Buttons are used only for direct actions.

#### Service Preview

Use a macOS-style window frame to explain the shared services visually. It should be a product diagram, not a decorative card. Keep status colors limited to small window dots and small status pills.

#### Code Blocks

Dark graphite background, muted light code text, rounded-lg radius, copy button in the top-right. Commands must remain easy to copy.

#### Content Cards

Use white-tinted panels with hairline borders and subtle shadow. Avoid repeated icon grids.

### Motion

Keep motion minimal. Use hover transitions only on navigation and buttons. Do not animate layout properties.

### Copy Rules

- French interface copy is acceptable.
- Be direct and technical.
- Prefer short sentences.
- Do not use em dashes.
- Do not over-explain features already obvious from a command.

### Accessibility

- Preserve semantic headings, tables, captions, and nav labels.
- Keep color contrast readable on all text.
- Ensure mobile navigation toggles `aria-expanded`.
- Do not rely on color alone to explain the workflow.
