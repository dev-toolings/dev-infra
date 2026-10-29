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

- Neutral OKLCH tokens only: `background`, `foreground`, `muted`, `border`,
  `primary` (near black in light mode, near white in dark mode).
- Color means state, never decoration:

| State | Badge variant | Used for |
|---|---|---|
| Healthy | `up` | running, ready, succeeded, validated |
| Warning | `degraded` | medium severity |
| Failing | `down` | unhealthy, failed, critical and high severity |
| Idle | `muted` | stopped, exited, completed scans |
| Neutral | `outline` | kinds, counts, unknown or unavailable |

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
- Projects: list and detail side by side from `lg`
  (`minmax(17rem,22rem)` and `minmax(0,1fr)`). Containers: two columns from `xl`.
- Mobile: the sidebar becomes a sheet behind the header trigger. No horizontal overflow.

### Components

- Buttons: `h-8` by default, `sm` (`h-7`) inside cards. One primary button per area.
- Cards: `rounded-xl`, hairline border, `shadow-xs`. `CardHeader` is a grid: add
  `flex flex-row` for a header that puts actions on the same line.
- Session menu (sidebar footer): theme switch (light, dark, system) and Log out.
- Theme: stored under `devhub-theme`, applied before the first render.

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
- Error: `ErrorState`, or `ActionBanner` when content is already on screen.

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
